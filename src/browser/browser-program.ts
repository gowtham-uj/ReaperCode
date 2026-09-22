/**
 * What a model's browser program is handed, and where the calls come from.
 *
 * The program runs inside the sandbox with no browser connection. It holds
 * proxies, and every Playwright call travels back over the IPC socket to be
 * replayed here against the thread's own page. This module is the host end of
 * that: it owns the roots, answers the frames, and runs the observation helpers
 * that are not Playwright calls.
 *
 * ## Why the surface is four things and not one
 *
 * The question "is `page` enough" has a clear answer, and it is no. A model that
 * can only act on the page it was given cannot open a tab, cannot close one, and
 * cannot find its way back to a tab it left. So the surface is:
 *
 *   page          the scoped Playwright Page: click, fill, goto, locator, close
 *   browser       page lifecycle: newPage(name), pages(), usePage(name|index)
 *   view          what the page looks like, for the model to read
 *   viewChanges   what changed since it last looked
 *
 * `page` and `browser` are Playwright-shaped, so a model writing Playwright
 * writes what it already knows. The difference is that `browser` is a facade
 * over the runtime rather than a raw Playwright Browser, because page *naming*
 * is the runtime's job: a page opened through raw Playwright is anonymous and
 * unpinned, and a model that opens a tab and returns to the listing has no way
 * to name the one it left. Rooting `browser` here is what keeps `pages()` and
 * `usePage("cart")` working, and it costs nothing because the proxy replays
 * against whatever object the host chose.
 *
 * `page` is the real Playwright Page, scoped. Everything on it works, including
 * `page.close()`, because the proxy replays any method: nothing here enumerates
 * the Page API, so nothing here goes stale when Playwright adds to it.
 *
 * ## Isolation
 *
 * The scoping is what keeps one agent out of another's tabs, and it is applied
 * to the object the handle roots at, so it holds for every call the model makes
 * through it. A model writing `page.context().browser().contexts()` gets this
 * thread's context and nothing else, because `scopePage` and `scopeBrowser`
 * already dead-end that chain. This module does not re-implement any of it.
 */

import type { Page } from "playwright";

import { RemotePageHost, type CallResult } from "./remote-page.js";
import { scopeFacade, scopePage } from "./scoped-page.js";
import type { ThreadBrowserRuntime } from "./thread-runtime.js";

/** Whether a value the host produced is a Playwright Page, by shape. */
function isPageLike(value: unknown): value is Page {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { context?: unknown }).context === "function" &&
    typeof (value as { waitForEvent?: unknown }).waitForEvent === "function" &&
    typeof (value as { goto?: unknown }).goto === "function"
  );
}

/** The observation helpers, which are not Playwright calls. */
export interface ObserveSurface {
  view: (target?: Page) => Promise<string>;
  viewChanges: () => string;
  screenshot: (target?: Page) => Promise<string>;
  /**
   * The browser settings a program can change, and the calls that do it.
   *
   * Part of the same surface because they are the same kind of thing to a
   * program: a named call the host answers. They live here rather than in
   * `ThreadBrowserRuntime`'s public API only because they were added later, and
   * putting them on the observe surface keeps the worker's parameter list and
   * the tool's documentation in one place.
   */
  control: ControlSurface;
}

/**
 * The settings calls a program can make.
 *
 * Every one returns a report rather than void, because the honest answer is
 * sometimes "that will apply at the next launch" and a program that is told
 * nothing would believe a setting took effect when it did not.
 */
export interface ControlSurface {
  set: (settings: Record<string, unknown>) => Promise<ControlReport>;
  setUserAgent: (userAgent: string) => Promise<ControlReport>;
  setTimezone: (timezone: string) => Promise<ControlReport>;
  setViewport: (width: number, height: number) => Promise<ControlReport>;
  setFullscreen: (enabled: boolean) => Promise<ControlReport>;
  /** Present as a phone: user agent, mobile viewport and touch, together. */
  setMobile: (enabled: boolean) => Promise<ControlReport>;
  blockAds: (enabled: boolean) => Promise<ControlReport>;
  bandwidth: (options: Record<string, unknown>) => Promise<ControlReport>;
  settings: () => Promise<Record<string, unknown>>;
  rotateUserAgent: () => Promise<ControlReport>;
  /** Files this thread has downloaded, with the names and sizes. */
  downloads: () => Promise<Array<{ name: string; bytes: number; url?: string }>>;
  /** Resolve one downloaded file to an absolute path, for an upload input. */
  download: (name: string) => Promise<{ name: string; path: string; bytes: number } | undefined>;
  /**
   * Run a snippet that triggers a download, and answer with the file it produced.
   *
   * The pair in one call, because waiting for the event across the bridge
   * deadlocks: see the note in `observeCall`.
   */
  downloadAfter: (target: unknown) => Promise<{ name: string; path: string; bytes: number }>;
  /**
   * Replace a page's renderer, which fixes input a page has stopped accepting.
   *
   * A page can reach a state where it renders, answers reads and navigates, but
   * silently drops every trusted input event: clicks return without error and
   * dispatch nothing, typing into a focused field does nothing, Tab does not
   * move focus. Measured on a live mission, where the agent spent thirty of its
   * trace blocks proving the page's own JavaScript was fine before finding this
   * by accident.
   *
   * A cross-origin navigation replaces the renderer process and clears it. That
   * is what this does, and it exists as a name because doing it by hand is a
   * discovery the model should not have to make: the failure looks exactly like
   * a broken page, and there is nothing on the page to point at the browser.
   */
  recover: (target?: unknown) => Promise<ControlReport>;
  /**
   * Whether a page's renderer still accepts input.
   *
   * Answers the question a model otherwise spends a dozen calls building
   * listeners to answer, and answers it definitively: a click delivered through
   * CDP either reaches the page or does not.
   */
  probeInput: (target?: unknown) => Promise<{ delivered: boolean; note: string }>;
  /**
   * What this browser can do, so the model asks rather than experiments.
   *
   * The mission spent thirteen calls establishing whether downloads were possible
   * and several more probing whether trusted input worked. Both are facts the
   * runtime already holds, and a fact the model cannot query is a fact it will
   * try to discover by acting, which is the expensive way.
   */
  capabilities: () => Promise<Record<string, unknown>>;

  /*
   * The transactional surface, below.
   *
   * These are the calls that replace work the model was doing by hand. Each one
   * exists because a measured run did the same thing repeatedly and badly:
   * deciding whether an element could be clicked, reading a form's constraints,
   * waiting for a change, catching a download, asking a page to open a popup.
   *
   * ## The arm/run/collect split, and why it is not avoidable
   *
   * Three of these take a *body*: a transaction, a download trigger, a popup
   * trigger. A function cannot cross the bridge, and that is the boundary the
   * sandbox is built on: the host used to rebuild functions from source with an
   * eval, which is an escape in the app-server process, and the fix was to stop.
   *
   * So a body always runs where it was written. The runtime supplies the halves
   * that need a live page, and the sandbox stitches them together, which is
   * exactly how `downloadAfter` already works. The names below are those halves:
   *
   *   txBegin / txEnd          bracket a body, so the runtime can diff the page
   *   armDownload / collectDownload
   *   armPopup / collectPopup
   *
   * The ergonomic single calls (`browser.tx(...)`, `browser.download(...)`) are
   * built from them in `remote-page-source.ts`, in the sandbox, where the body
   * is. That is not an implementation detail leaking: it is the only arrangement
   * that keeps a program's functions on the program's side of the wall.
   */

  /**
   * Open a transaction and record the page's state before the body runs.
   *
   * Returns a token the matching `txEnd` needs, and the receipt's first half.
   */
  txBegin: (options: Record<string, unknown>) => Promise<unknown>;

  /**
   * Close a transaction and answer with the receipt.
   *
   * The receipt carries the status, the URL transition, the change flags and the
   * body's value, rather than the page. That is what keeps a step's answer to a
   * few hundred tokens instead of a full accessibility tree.
   */
  txEnd: (
    token: string,
    outcome: { ok: boolean; value?: unknown; error?: { name: string; message: string }; sleeps?: string[] },
  ) => Promise<unknown>;

  /**
   * Ask whether an element can be acted on, before acting on it.
   *
   * Runs Playwright's own actionability trial, which checks visibility,
   * stability, enabled state and pointer-event receipt without clicking. On
   * failure it reports the classified reason and, for the two failures that have
   * a mechanical fix, the evidence for it.
   */
  inspect: (target: unknown, action?: string) => Promise<unknown>;

  /**
   * Read a form's constraints, so a value is chosen rather than guessed.
   *
   * Answers from the markup and the Constraint Validation API: `required`,
   * `maxlength`, `pattern`, and the live `ValidityState` with the browser's own
   * explanation.
   */
  inspectForm: (form?: unknown) => Promise<unknown>;

  /**
   * Wait until the page changes, or until a condition holds.
   *
   * The replacement for `waitForTimeout`. Given no argument it waits for any
   * change; given an expectation it waits for that specific one.
   */
  waitForChange: (options: Record<string, unknown>) => Promise<unknown>;

  /**
   * Playwright's assertion, so the documented call is not a `ReferenceError`.
   *
   * `expect(locator).toBeVisible()` is the idiomatic way to wait for a condition
   * and both the skill and the wait policy told a model to write it, while the
   * sandbox bound no such name. The call is a named assertion rather than an
   * object, because the host answers one round trip and the sandbox is where the
   * `expect(x).toBeY()` shape is stitched together.
   */
  expect: (assertion: string, target: unknown, expected?: unknown, options?: Record<string, unknown>) => Promise<unknown>;

  /** Start listening for a download, before the trigger runs. */
  armDownload: (timeoutMs?: number) => Promise<unknown>;

  /** Wait for an armed download and store it inside the workspace. */
  collectDownload: (token: string) => Promise<unknown>;

  /**
   * Start listening for a popup on a page, before the trigger runs.
   *
   * The alternative is `context.newPage()`, which produces a tab and not a
   * popup, and which a task that asked for a click will correctly refuse.
   */
  armPopup: (page: unknown, timeoutMs?: number) => Promise<unknown>;

  /** Wait for an armed popup, register it with provenance, and return it. */
  collectPopup: (token: string) => Promise<unknown>;

  /**
   * What this mission knows, outside the conversation.
   *
   * Facts carry their evidence, subtasks carry their state, and the object
   * survives compaction because it is not in the transcript.
   */
  state: {
    get: () => Promise<unknown>;
    fact: (name: string, value: string, evidence?: string) => Promise<unknown>;
    derive: (name: string, value: string, from?: string) => Promise<unknown>;
    subtask: (title: string, status?: string, requires?: string[]) => Promise<unknown>;
    ready: () => Promise<unknown>;
    artifact: (name: string, path: string, bytes?: number) => Promise<unknown>;
  };

  /** The browsing metrics, folded from the event ledger. */
  metrics: () => Promise<unknown>;
}

/**
 * What a settings call actually did.
 *
 * `applied` and `nextLaunch` are separate on purpose: a setting that only takes
 * effect when Steel next starts Chrome is not a failure, but reporting it as
 * applied would be a lie the model then builds on.
 */
export interface ControlReport {
  applied: string[];
  nextLaunch: string[];
  /** The settings in force after the call. */
  current: Record<string, unknown>;
  /** Present when a rotation happened, naming why. */
  note?: string;
}

/**
 * The page-lifecycle facade a program's `browser` is rooted at.
 *
 * Deliberately not a Playwright Browser. It offers the four things a browsing
 * task needs and nothing else, because every method here has to keep the
 * runtime's own bookkeeping true: a page opened through this is named, pinned
 * active, and listed, which is what makes `pages()` and `usePage` mean something
 * a few steps later.
 */
export class BrowserFacade {
  /*
   * `#runtime` rather than `private readonly runtime`, and the difference is the
   * whole point.
   *
   * TypeScript's `private` is erased at runtime: `private readonly runtime` is a
   * plain own property, and this class is handed to a sandboxed program as an
   * ordinary object so its methods can be called. So `browser.runtime` read the
   * ThreadBrowserRuntime out of the facade, and from there the model could reach
   * the router's own bookkeeping: the context, the handles, the app-server's
   * dependencies behind it.
   *
   * A `#` field is not a property at all. It is enforced by the language, it does
   * not appear in `Object.keys`, `JSON.stringify` or `Reflect.ownKeys`, and no
   * string can name it. Reproduced by reading `browser.runtime` off the root a
   * program is given.
   *
   * Every internal use becomes `this.#runtime`, which is the same call.
   */
  readonly #runtime: ThreadBrowserRuntime;

  /**
   * Every internal field is `#`, and that is the finding rather than a style.
   *
   * The same argument as `#runtime` applies to all of them, because the facade
   * is handed to a sandboxed program as an ordinary object and `RemotePageHost`
   * reads *any* property name off it. `initial` was `private readonly` and held
   * the raw, unscoped `Page`: `browser.initial.context().browser().contexts()`
   * returned one merged context holding every thread's tabs, so a program could
   * list and drive another thread's page by URL. `onRepin` was readable the same
   * way, and it is a function the program could call with an arbitrary object.
   *
   * Neither is reachable by name now, because a `#` field is not a property. The
   * facade is also wrapped in a name allowlist before it crosses (see
   * `scopeFacade`), so a field added here later cannot reopen the same door.
   */
  readonly #initial: Page | undefined;
  readonly #onRepin: ((page: Page) => void) | undefined;

  constructor(
    runtime: ThreadBrowserRuntime,
    /**
     * Called when the program itself changes the active page.
     *
     * This is the only thing allowed to re-pin a program's `page`. The runtime
     * re-pins its own active page for internal reasons, and following those
     * silently redirected a running program mid-step: a listener armed on one
     * page, a click that landed on another, and a counter that read zero.
     */
    onRepin?: (page: Page) => void,
  ) {
    this.#runtime = runtime;
    this.#initial = runtime.activePage;
    this.#onRepin = onRepin;
  }

  /*
   * Every page this hands out is SCOPED, and that is not a detail.
   *
   * These returned the runtime's raw pages, so a program that opened a tab
   * through the facade and then walked the chain from that tab reached every
   * other thread: `tab.context().browser().contexts()` returned 2 contexts and
   * listed another agent's page by URL. Verified by running it. The scoping was
   * applied only to the primary root, which closed the chain for a program that
   * started from `page` and left it open for one that started from a tab it had
   * just opened.
   *
   * So the wrapping happens here, at the single place pages leave the runtime,
   * rather than at each call site. A page that escapes unscoped is the whole
   * bug, and there is exactly one door.
   */
  private scoped(page: Page): Page {
    /*
     * Through the runtime, so context tracking comes with it.
     *
     * This is the door that mattered and the third time this fix was wired
     * somewhere else: the program's `page` resolves through `currentPage()` here,
     * not through the object `BrowserProgramHost` was constructed with, so a
     * callback on the constructor's page never ran. Measured each time rather
     * than assumed, because the code read as fixed twice while the leak stayed
     * open (contexts 1 -> 2, `tracked: 0`).
     *
     * Delegating rather than repeating the call is the point: there is now one
     * place that scopes a page for a program, and it cannot be forgotten at a
     * fourth call site.
     *
     * The fallback is for the tests, which build the facade over a stub runtime
     * with no such method, and it is honest rather than a silence: a runtime that
     * cannot track contexts is a runtime that has none to track, and a stub is
     * exactly that.
     */
    const scopedWithTracking = (this.#runtime as { scopeForProgram?: (page: Page) => Page }).scopeForProgram;
    return scopedWithTracking === undefined
      ? scopePage(page, this.#runtime.threadId)
      : scopedWithTracking.call(this.#runtime, page);
  }

  /** Open a page in this thread's own context, optionally naming it. */
  async newPage(name?: string): Promise<Page> {
    /*
     * Re-pins, because opening a tab makes it the active page: the documented
     * contract is that `page` is the active page, so a program that has just
     * opened one means the new one by `page`.
     */
    const page = this.scoped(await this.#runtime.newPage(name));
    this.#onRepin?.(page);
    return page;
  }

  /**
   * Every open page in this thread, scoped, in display order.
   *
   * This returns the real pages rather than descriptors, because the
   * documented usage is `await browser.pages()` followed by calling methods on
   * the elements: the skill's "multiple pages" example and the tool
   * description both read `browser.pages()` as a list of tabs, and a caller
   * doing `(await browser.pages())[0].url()` is following the stated contract.
   *
   * It used to return `{name, url, active, index}` records, so that call threw
   * "p.url is not a function". Worse, it was inconsistent with the rest of the
   * surface: `browser.newPage("cart")` hands back a real page, so the same
   * object type a program gets from `newPage` did not match what it got from
   * `pages()`, and the failure looked like a bug in the caller's program
   * rather than in the API.
   *
   * The name and active flag are attached as non-enumerable properties so a
   * program that wants them still can, without them showing up when the list is
   * serialized into the transcript.
   */
  async pages(): Promise<Page[]> {
    return this.#runtime.describePages();
  }

  /**
   * Make a page the one a bare `page` means. By name or by index.
   *
   * Three names for one call, deliberately, and the reason is that a model
   * writes what it has been taught. `setActive` is the documented surface a
   * program in the field already uses; `page(name)` is the spelling the browser
   * skill shows in its examples and the one Playwright's own vocabulary
   * suggests; `usePage` reads correctly in a program. All three go to the same
   * runtime call, so there is one behaviour and three doors to it, and a model
   * that reaches for any of them is right rather than nearly right.
   */
  async setActive(selector: string | number | Page): Promise<Page> {
    const page = this.scoped(await this.#runtime.setActive(selector));
    this.#onRepin?.(page);
    return page;
  }

  /** The same call, spelled the way the skill's examples show it. */
  async page(selector: string | number | Page): Promise<Page> {
    return await this.setActive(selector);
  }

  /** The same call under the name that reads best in a program. */
  async usePage(selector: string | number | Page): Promise<Page> {
    return await this.setActive(selector);
  }

  /** Close a page and forget it, so a name is not left pointing at a corpse. */
  async closePage(page: Page): Promise<void> {
    await this.#runtime.closePage(page);
  }

  /** The page a bare `page` currently means. */
  async current(): Promise<Page> {
    return this.scoped((await this.#runtime.ensureReady()).page);
  }

  /**
   * The active page, scoped, for the host to root `page` at.
   *
   * Scoped here rather than left raw, because this is what the program's `page`
   * resolves to on every call: handing back the runtime's own handle would let
   * a program that switched tabs walk `page.context().browser().contexts()` out
   * of its thread, which is the isolation the `scoped-page` boundary exists to
   * hold. A fresh proxy per call is deliberate and cheap: the proxy forwards to
   * the same real object, so identity of the *target* is preserved while the
   * guard is applied to whatever page is active at that moment.
   */
  currentPage(): Page | undefined {
    const active = this.#runtime.activePage ?? this.#initial;
    return active === undefined ? undefined : this.scoped(active);
  }

  /** Write this thread's cookies now, mid-program. */
  async save(): Promise<void> {
    await this.#runtime.save();
  }
}

/** A settings argument, coerced from whatever crossed the boundary. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * The host end of one browser program.
 *
 * Lives for the length of a single program. It owns the handle table (through
 * `RemotePageHost`), the roots the program's proxies resolve against, and the
 * observation helpers, which are the calls that are not Playwright calls and so
 * cannot travel as a method path.
 */
export class BrowserProgramHost {
  private readonly inner: RemotePageHost;

  constructor(
    private readonly runtime: ThreadBrowserRuntime,
    private readonly page: Page,
    private readonly observe: ObserveSurface,
  ) {
    /*
     * The roots, in the order the worker expects them in `browserRoots`.
     *
     * Handle 0 is the page, because that is the one every program starts from
     * and the one whose absence would break everything. The browser and the
     * page list follow.
     */
    const browser = page.context().browser();
    if (!browser) throw new Error("the page has no browser attached");
    /*
     * `browser` roots at the facade, not at the scoped Playwright Browser.
     *
     * The facade is what keeps page naming and active-pinning true: `newPage`
     * through it goes to the runtime, so the page is named and pinned, and
     * `usePage("cart")` can find it later. A raw scoped Browser would refuse
     * `newPage` outright, which is the guard working exactly as designed and
     * exactly the wrong thing to root a program at.
     */
    let pinned: Page | undefined;
    const facade = new BrowserFacade(runtime, (next) => { pinned = next; });
    /*
     * `page` is resolved on every use, but only the *program* may change what it
     * means.
     *
     * The two failures pull in opposite directions and the fix has to satisfy
     * both. Binding the page object once at construction was wrong: a program
     * that called `browser.setActive("hn")` and then used `page` drove the tab it
     * had just left. So the resolution has to be live.
     *
     * Resolving it from the runtime's current active page on every call was the
     * other extreme, and it is the bug that cost a mission twenty tool calls. The
     * runtime re-pins its active page for reasons that are none of a program's
     * business — a handle reset, a page list re-read, a health sweep — and every
     * one of those silently redirected the program's `page` mid-flight. The
     * measured shape: a program installed a document listener, clicked, and read
     * its counter back, and got `0`, because the three calls had gone to two
     * different pages. The agent concluded the page had stopped accepting input
     * and spent the rest of the run on that theory.
     *
     * So the page is pinned for the life of the program, and `setActive` is the
     * one thing that re-pins it — which is exactly the contract the skill
     * documents: `page` is the active page, and the program decides which one
     * that is.
     */
    this.inner = new RemotePageHost(() => (pinned ??= facade.currentPage() ?? page), {
      /*
       * The scoped facade, not the raw one.
       *
       * The raw facade is an ordinary class instance, so every own property on
       * it was readable by name from inside the sandbox: `browser.initial` handed
       * back the raw unscoped Page, and `browser.runtime` handed back the whole
       * runtime. `#` fields close the two that exist today; the allowlist closes
       * the class, including whatever is added next.
       */
      browser: scopeFacade(facade),
      /*
       * `pages` roots at the *method*, not at the facade.
       *
       * A root is what the program calls: `pages()` invokes the root directly,
       * with no step before it. Rooting at the facade would mean calling the
       * facade object itself, which is not a function, and the program got
       * "this object is not callable" for a call that is documented to work.
       * Bound so it keeps its `this` after crossing the wire.
       */
      pages: () => facade.pages(),
    });
  }

  /** The handles the worker's surface roots at. */
  roots(): Record<string, number> {
    return this.inner.roots();
  }

  /**
   * Put a live object into the handle table, and answer with its handle.
   *
   * The single door for an object the sandbox should be able to call Playwright
   * on but which the host produced rather than the program. `expectPopup` is the
   * case: Playwright hands the host a Page and the program needs to drive it.
   *
   * Returns undefined when the table is full, which the caller must answer with
   * a real error rather than a handle that resolves to nothing.
   */
  intern(value: unknown): number | undefined {
    /*
     * A page is scoped on the way in, and this was a real escape.
     *
     * `expectPopup` interns a Playwright Page the host received from
     * `waitForEvent("popup")`, and this stored it raw. Every later call the
     * program makes on that handle is replayed against the stored object, so the
     * documented popup helper handed back a page whose `context().browser()
     * .contexts()` listed every thread's tabs. The isolation tests passed because
     * they started from `page`, and this is a different door.
     *
     * Scoping here rather than at the call site, because this is the one place an
     * object the *host* produced enters the handle table, and there is exactly
     * one such caller today. The check is on the object's shape rather than on
     * the caller's intent, so a second caller added later is covered.
     */
    return this.inner.intern(isPageLike(value) ? this.scopeHostPage(value) : value);
  }

  /**
   * A host-produced page, scoped to this thread.
   *
   * Through the runtime when it can, so context tracking comes with it, and
   * through `scopePage` otherwise, which is what the tests' stub runtime needs.
   */
  private scopeHostPage(page: Page): Page {
    const scopedWithTracking = (this.runtime as { scopeForProgram?: (page: Page) => Page }).scopeForProgram;
    return scopedWithTracking === undefined ? scopePage(page, this.runtime.threadId) : scopedWithTracking.call(this.runtime, page);
  }

  /**
   * Answer one call frame.
   *
   * A handle of -1 is not a Playwright call but a call to an observation helper,
   * which the worker sends on the same channel because it is the same round trip
   * and the same failure handling. Keeping it on one channel is what stops the
   * helpers needing their own error path, their own deadline, and their own
   * place in the transcript.
   */
  async call(handle: number, path: Array<{ method: string; args: unknown[] }>): Promise<CallResult> {
    if (handle === -1) return await this.observeCall(path);
    return await this.inner.call(handle, path);
  }

  /**
   * Turn the handle markers in an observation call's arguments into real objects.
   *
   * The observation helpers do not go through `RemotePageHost.call`, so they do
   * not get its argument revival, and `view(locator)` arrived holding
   * `{ __reaperNode: 7 }` where a Locator was meant. The helper then read the
   * whole page instead of the region, which is the exact failure this scoping
   * exists to prevent and is silent: the call succeeds and returns too much.
   */
  private resolveArgs(args: unknown[]): unknown[] {
    return args.map((arg) => {
      /*
       * A RegExp marker is revived here too, and the omission was a real bug.
       *
       * The observation helpers do not go through `RemotePageHost.call`, so they
       * do not get its `reviveArguments`. That was fine while every helper took
       * numbers and strings, and it stopped being fine the moment a helper took
       * a pattern: the sandbox encodes a RegExp as `{ __reaperRegExp, source,
       * flags }`, so `expect(page).toHaveURL(/example\.com/)` reached the host as
       * a plain object and the assertion compared the URL against the string
       * "[object Object]", which can never match. Measured live: the call failed
       * with "expected page ... to have URL [object Object]".
       *
       * `helperResolve` is the host's own revive-then-resolve, exposed for
       * exactly this: one implementation of "make a wire argument real", so a
       * helper and a method call cannot disagree about what a marker means.
       */
      return this.inner.helperResolve(arg);
    });
  }

  /** One `view`, `viewChanges` or `screenshot` call from inside the sandbox. */
  private async observeCall(path: Array<{ method: string; args: unknown[] }>): Promise<CallResult> {
    const step = path[0];
    if (!step) return { kind: "error", name: "BadCall", message: "the observation call had no method" };
    const target = this.resolveArgs(step.args)[0] as Page | undefined;
    const args = this.resolveArgs(step.args);
    try {
      switch (step.method) {
        case "view":
          return { kind: "value", value: await this.observe.view(target) };
        case "viewChanges":
          return { kind: "value", value: this.observe.viewChanges() };
        case "screenshot":
          return { kind: "value", value: await this.observe.screenshot(target) };
        /*
         * `downloadAfter`, which exists because the obvious spelling deadlocks.
         *
         * `page.waitForEvent("download")` goes through the same bridge as every
         * other call, and that bridge awaits the promise before returning. A
         * download event only fires when something *else* runs, and through the
         * bridge that something else is the next step of the same program, which
         * cannot start until the first one returns. So the wait held the only
         * thread that could have produced the event, and the program timed out
         * with no error: measured, 30s and then `OUTCOME: TIMEOUT` for both
         * `Promise.all([wait, click])` and the sequential wait-then-click form.
         *
         * The host can interleave them because it holds the real page, so the
         * pair is one helper here: the action is a source string the host
         * evaluates, and it waits for the download while that runs.
         */
        case "downloadAfter":
          return { kind: "value", value: await this.observe.control.downloadAfter(args[0]) };
        /*
         * The control calls. Each returns a plain object, which crosses the
         * boundary as data, so a program can read what changed.
         */
        case "set":
          return { kind: "value", value: await this.observe.control.set(asRecord(args[0])) };
        case "setUserAgent":
          return { kind: "value", value: await this.observe.control.setUserAgent(String(args[0] ?? "")) };
        case "setTimezone":
          return { kind: "value", value: await this.observe.control.setTimezone(String(args[0] ?? "")) };
        case "setViewport":
          return {
            kind: "value",
            value: await this.observe.control.setViewport(Number(args[0]), Number(args[1])),
          };
        case "setFullscreen":
          return { kind: "value", value: await this.observe.control.setFullscreen(args[0] === true) };
        case "setMobile":
          return { kind: "value", value: await this.observe.control.setMobile(args[0] === true) };
        case "blockAds":
          return { kind: "value", value: await this.observe.control.blockAds(args[0] === true) };
        case "bandwidth":
          return { kind: "value", value: await this.observe.control.bandwidth(asRecord(args[0])) };
        case "settings":
          return { kind: "value", value: await this.observe.control.settings() };
        case "rotateUserAgent":
          return { kind: "value", value: await this.observe.control.rotateUserAgent() };
        case "downloads":
          return { kind: "value", value: await this.observe.control.downloads() };
        case "download":
          return { kind: "value", value: await this.observe.control.download(String(args[0] ?? "")) };
        /*
         * The three diagnostics, and the third place this surface had to be
         * completed.
         *
         * They were documented, listed in `BROWSER_PROGRAM_PARAMS`, absent from
         * the sandbox's returned object, and absent from here. A model told to
         * call `capabilities()` before spending steps got "capabilities is not
         * defined", then probed the scope and got a false positive from the
         * membrane proxy, then gave up and discovered the API by hand. Three
         * omissions for one documented call, which is why the pairing of this
         * switch with the surface is now asserted rather than assumed.
         *
         * `target` is optional on all three. `recover()` with no argument means
         * the active page, which is the common case; a program that names one
         * gets that page.
         */
        case "recover":
          return { kind: "value", value: await this.observe.control.recover(target) };
        case "probeInput":
          return { kind: "value", value: await this.observe.control.probeInput(target) };
        case "capabilities":
          return { kind: "value", value: await this.observe.control.capabilities() };
        /*
         * The transactional calls. Each is answered by the runtime through the
         * control surface, because each needs a real page and the runtime's own
         * primitives, neither of which the sandbox holds.
         */
        case "txBegin":
          return { kind: "value", value: await this.observe.control.txBegin(asRecord(args[0])) };
        case "txEnd":
          return {
            kind: "value",
            value: await this.observe.control.txEnd(
              String(args[0] ?? ""),
              asRecord(args[1]) as { ok: boolean; value?: unknown; error?: { name: string; message: string } },
            ),
          };
        case "inspect":
          return { kind: "value", value: await this.observe.control.inspect(args[0], args[1] as string | undefined) };
        case "inspectForm":
          return { kind: "value", value: await this.observe.control.inspectForm(args[0]) };
        case "waitForChange":
          return { kind: "value", value: await this.observe.control.waitForChange(asRecord(args[0])) };
        case "expect":
          return {
            kind: "value",
            value: await this.observe.control.expect(
              String(args[0] ?? ""),
              args[1],
              args[2],
              asRecord(args[3]),
            ),
          };
        case "armDownload":
          return { kind: "value", value: await this.observe.control.armDownload(args[0] as number | undefined) };
        case "collectDownload":
          return { kind: "value", value: await this.observe.control.collectDownload(String(args[0] ?? "")) };
        case "armPopup":
          return { kind: "value", value: await this.observe.control.armPopup(args[0], args[1] as number | undefined) };
        case "collectPopup":
          return { kind: "value", value: await this.observe.control.collectPopup(String(args[0] ?? "")) };
        case "stateGet":
          return { kind: "value", value: await this.observe.control.state.get() };
        case "stateFact":
          return { kind: "value", value: await this.observe.control.state.fact(String(args[0] ?? ""), String(args[1] ?? ""), args[2] as string | undefined) };
        case "stateDerive":
          return { kind: "value", value: await this.observe.control.state.derive(String(args[0] ?? ""), String(args[1] ?? ""), args[2] as string | undefined) };
        case "stateSubtask":
          return {
            kind: "value",
            value: await this.observe.control.state.subtask(
              String(args[0] ?? ""),
              args[1] as string | undefined,
              Array.isArray(args[2]) ? (args[2] as string[]) : undefined,
            ),
          };
        case "stateReady":
          return { kind: "value", value: await this.observe.control.state.ready() };
        case "stateArtifact":
          return {
            kind: "value",
            value: await this.observe.control.state.artifact(String(args[0] ?? ""), String(args[1] ?? ""), Number(args[2] ?? 0)),
          };
        case "metrics":
          return { kind: "value", value: await this.observe.control.metrics() };
        default:
          /*
           * A screenshot is the only helper that returns an image, and an
           * unknown name here is a bug in the injected source rather than
           * something the model did, so it is worth saying so precisely.
           */
          return { kind: "error", name: "UnknownHelper", message: `${step.method} is not an observation helper` };
      }
    } catch (error) {
      return { kind: "error", name: (error as Error).name, message: (error as Error).message };
    }
  }
}
