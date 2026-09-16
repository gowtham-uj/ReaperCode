/**
 * One thread's browser, and the code that runs in it.
 *
 * This is the piece that makes pages and logins survive between tool calls. A
 * `Page` is a live object bound to a connection; it cannot be serialized across
 * a process boundary and proxying it would make `page.url()` return a Promise,
 * which is the one thing this design refuses to do. So the connection has to
 * live in the same process as the model's code, and that process has to outlive
 * a single call — which is why there is one long-lived worker per thread rather
 * than the fresh-per-eval worker `eval` uses.
 *
 * Two facts about Playwright shape everything here, both verified rather than
 * assumed:
 *
 * 1. **Contexts are per-connection.** `browser.contexts()` is populated by the
 *    connection that created them; a second connection sees one merged context
 *    containing every thread's pages. Contexts therefore only stay separate
 *    while the connection that made them is alive, and this runtime never drops
 *    its connection mid-thread.
 *
 * 2. **A page survives a dropped connection only if another one holds it.** So
 *    "reconnect and find my pages" is not a thing Playwright offers, and the
 *    design does not depend on it.
 *
 * Steel owns the browser process; this attaches to it over CDP. Steel is not
 * started here — the app-server does that, once, and this connects to whatever
 * is listening.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { PageObserver, type PageContentMeta, type PageViewOptions, type SnapshotStats } from "./page-view.js";
import { runStep, type SettleOptions, type StepReceipt } from "./transaction.js";

export interface ThreadRuntimeOptions {
  /** The thread this browser belongs to, for naming and logging. */
  threadId: string;
  /** CDP endpoint of the browser to attach to. */
  cdpUrl: string;
  /** How long to wait for the attach. */
  cdpTimeoutMs?: number;
  /** Contexts are created with this viewport. */
  viewport?: { width: number; height: number };
  /**
   * Where this thread's cookies are persisted, when they should be.
   *
   * Absent means in-memory only, which is right for a test and wrong for a
   * thread whose login has to survive a restart.
   */
  statePath?: string | undefined;
}

/**
 * What a named page is.
 *
 * Names matter because `browser.page(1)` by index breaks the moment a tab
 * closes, and a model that has just opened a cart tab and gone back to the
 * listing has no way to return to it by index.
 */
export interface NamedPage {
  name: string;
  page: Page;
  openedAt: number;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

export class ThreadBrowserRuntime {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private active: Page | undefined;
  private readonly named = new Map<string, NamedPage>();
  /** The counter behind auto-generated page names. */
  private anonymousCount = 0;
  readonly observer = new PageObserver();

  constructor(private readonly options: ThreadRuntimeOptions) {}

  /**
   * Attach if not already attached, and return the live handles.
   *
   * Concurrency-safe by construction: `connecting` holds the in-flight promise
   * so two calls arriving together attach once. Without that they would each
   * open a connection and one would be orphaned, holding a context that nothing
   * can reach and that never closes.
   */
  private connecting: Promise<void> | undefined;

  async ensureReady(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    if (this.browser && this.context && !this.browser.isConnected()) {
      // Steel restarted or the socket dropped. Drop everything: a stale context
      // is worse than a fresh one, because it looks alive and fails on use.
      this.resetHandles();
    }
    if (!this.browser || !this.context) {
      if (!this.connecting) this.connecting = this.attach().finally(() => { this.connecting = undefined; });
      await this.connecting;
    }
    const browser = this.browser;
    const context = this.context;
    if (!browser || !context) throw new Error("the browser could not be attached");
    const page = await this.resolveActivePage(context);
    return { browser, context, page };
  }

  private async attach(): Promise<void> {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(this.options.cdpUrl, {
      timeout: this.options.cdpTimeoutMs ?? 30_000,
    });
    /*
     * A new context per thread, always — never `browser.contexts()[0]`.
     *
     * The default context belongs to whoever got there first, and Steel reuses
     * one Chrome across sessions, so attaching to it shares a cookie jar with
     * every other thread. Verified as a real leak rather than inferred: a cookie
     * written in one context was readable from another when both used the
     * default.
     */
    /*
     * The thread's saved cookies are seeded into the new context, so a restart
     * does not cost every login. A missing file returns undefined and the context
     * starts clean, which is the same thing that happened before persistence
     * existed.
     */
    const state = await this.loadState();
    const context = await browser.newContext({
      viewport: this.options.viewport ?? DEFAULT_VIEWPORT,
      ...(state ? { storageState: state } : {}),
      // Steel's Chrome carries its own user agent; leaving this unset keeps it
      // consistent with what the browser reports elsewhere.
    });
    this.browser = browser;
    this.context = context;
    context.on("close", () => {
      // A script can reach `context.close()` through the sandbox. Nulling the
      // handles here is what stops the next eval finding a dead context and
      // failing every call on it.
      this.resetHandles();
    });
  }

  private resetHandles(): void {
    this.browser = undefined;
    this.context = undefined;
    this.active = undefined;
    this.activeTargetId = undefined;
    this.named.clear();
  }

  /**
   * The page a script's bare `page` refers to, pinned by CDP target id.
   *
   * It used to take `pages[pages.length - 1]`, which is the "active tab"
   * pattern and is wrong the moment a second tab exists. A page that opens a
   * popup moves its own index, so the next call drives the popup; a tab that
   * closes shifts every index after it. The failures that produces are
   * intermittent and look like the site misbehaving rather than like the tool
   * picking the wrong page.
   *
   * So the page is pinned once, by the CDP target id that identifies it in the
   * browser itself, and every later call resolves that id. If the pinned target
   * is gone the answer is an error naming the target, never a silent fallback
   * to whatever tab happens to be open, because acting on the wrong page is
   * worse than not acting.
   */
  private async resolveActivePage(context: BrowserContext): Promise<Page> {
    if (this.active && !this.active.isClosed()) {
      /*
       * The handle is only reused when the target behind it is the one we
       * pinned. Playwright can hand back a Page object after its target was
       * replaced, and reusing it would drive a page the model has not seen.
       */
      if (this.activeTargetId === undefined || (await targetIdOf(this.active)) === this.activeTargetId) {
        return this.active;
      }
    }
    const pages = context.pages().filter((p) => !p.isClosed());
    const page = pages[0] ?? (await context.newPage());
    this.active = page;
    try {
      this.activeTargetId = await targetIdOf(page);
    } catch {
      this.activeTargetId = undefined;
    }
    return page;
  }

  /** The CDP target id the active page is pinned to, when it is pinned. */
  activeTargetId: string | undefined;

  /**
   * A fresh page after the one we were driving was closed.
   *
   * Deliberately reads the context's live page list and only creates one when
   * there is genuinely nothing to use, because Steel may already have opened a
   * replacement: its own `refreshPrimaryPage` closes the old page and assigns a
   * new one, so by the time we look there is often a page waiting.
   *
   * The stale handle is dropped first. Re-using it is the failure this exists to
   * prevent: it looks like a page, it reports its old URL, and every call on it
   * rejects.
   */
  private async replaceClosedPage(): Promise<Page | undefined> {
    this.active = undefined;
    this.activeTargetId = undefined;
    const context = this.context;
    if (!context) return undefined;
    const live = context.pages().filter((candidate) => !candidate.isClosed());
    const page = live[0] ?? (await context.newPage().catch(() => undefined));
    if (!page) return undefined;
    this.active = page;
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    return page;
  }

  /** Open a page, optionally naming it. */
  async newPage(name?: string): Promise<Page> {
    const { context } = await this.ensureReady();
    const page = await context.newPage();
    const resolvedName = name ?? `page-${++this.anonymousCount}`;
    this.named.set(resolvedName, { name: resolvedName, page, openedAt: Date.now() });
    this.active = page;
    /*
     * Pin to the new page's target id immediately. Without this the first call
     * after opening a tab resolves by heuristics, and on a page that just opened
     * a popup those heuristics are exactly what picks the wrong one.
     */
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    return page;
  }

  /**
   * Every open page, with its name when it has one.
   *
   * The map is keyed by the Playwright `Page` object itself rather than by
   * stringifying it. `String(page)` is `[object Object]` for every page, so
   * every named page collided on one key and the list reported the last name
   * for all of them — which is how a two-page session came back as
   * `['cart', 'cart']`.
   */
  pagesForDisplay(): Array<{ name: string | undefined; url: string; active: boolean; index: number }> {
    if (!this.context) return [];
    const live = this.context.pages().filter((p) => !p.isClosed());
    const names = new Map<Page, string>();
    for (const entry of this.named.values()) {
      if (!entry.page.isClosed()) names.set(entry.page, entry.name);
    }
    return live.map((page, index) => ({
      name: names.get(page),
      url: page.url(),
      active: page === this.active,
      index,
    }));
  }

  /** The live Page objects, in the same order `pagesForDisplay` reports them. */
  pages(): Page[] {
    if (!this.context) return [];
    return this.context.pages().filter((p) => !p.isClosed());
  }

  /** Select the page a bare `page` will mean next. By name or by index. */
  async setActive(selector: string | number): Promise<Page> {
    const { context } = await this.ensureReady();
    if (typeof selector === "string") {
      const entry = this.named.get(selector);
      if (entry && !entry.page.isClosed()) {
        this.active = entry.page;
        this.activeTargetId = await targetIdOf(entry.page).catch(() => undefined);
        return entry.page;
      }
      throw new Error(`no open page named "${selector}". Open pages: ${[...this.named.keys()].join(", ") || "(none)"}`);
    }
    const live = context.pages().filter((p) => !p.isClosed());
    const page = live[selector];
    if (!page) throw new Error(`no page at index ${selector}; ${live.length} open`);
    this.active = page;
    return page;
  }

  /** Close a page, and forget it so a name is not left pointing at a corpse. */
  async closePage(page: Page): Promise<void> {
    for (const [name, entry] of this.named) {
      if (entry.page === page) this.named.delete(name);
    }
    if (this.active === page) this.active = undefined;
    await page.close().catch(() => undefined);
  }

  /**
   * Capture the page's outline into the observer, so the next observation is a
   * delta rather than the page.
   *
   * Called by the runtime after every action, not by the model: the model should
   * not have to remember to look. What it gets back is the diff.
   */
  async capture(page?: Page): Promise<void> {
    const target = page ?? (await this.ensureReady()).page;
    /*
     * Playwright's own `mode: "ai"` output, passed through unchanged.
     *
     * There used to be a hand-written renderer here that walked the JSON tree
     * and emitted its own format. It was deleted once the JSON tree arrived and
     * a second opinion about what a page contains turned out to be exactly the
     * thing to avoid: every place a custom renderer disagreed with Playwright's
     * was a place the model was told something Playwright would not have said.
     * Verified byte-identical, so there is nothing left for it to add.
     */
    const snapshot = await target.ariaSnapshot({ mode: "ai" });
    this.observer.capture({ url: target.url(), title: await target.title().catch(() => ""), snapshot });
  }

  /** The whole page, as the model should read it. */
  async view(options: PageViewOptions = {}): Promise<{ text: string; truncated: boolean; stats: SnapshotStats; contentMeta: PageContentMeta }> {
    const active = await this.ensureReady();
    /*
     * What to read, in order of specificity: a locator the caller passed, then a
     * selector, then a named page, then the active page.
     *
     * The locator case is the one that was wrong. `view(page.getByRole("main"))`
     * passes a Locator, and the first version only recognised a Page, so anything
     * else fell through to the active page and rendered the WHOLE page. The call
     * succeeded and the model got the wrong thing, which is the worst shape a bug
     * can take here: a program that scopes a look to one region to save tokens
     * silently pays for the whole page and never learns why.
     */
    const scoped = isLocator(options.page) ? options.page : undefined;
    const page = isPage(options.page) ? options.page : active.page;
    const target = scoped ?? (options.selector ? page.locator(options.selector).first() : page);
    const snapshot = await target.ariaSnapshot({
      mode: "ai",
      ...(options.depth ? { depth: options.depth } : {}),
    });
    if (options.selector) {
      // A scoped look replaces what the observer is holding, so a later diff is
      // against what the model actually saw rather than the whole page it did not.
      this.observer.capture({ url: page.url(), title: await page.title().catch(() => ""), snapshot });
      return this.observer.view(`selector: ${options.selector}`);
    }
    this.observer.capture({ url: page.url(), title: await page.title().catch(() => ""), snapshot });
    return this.observer.view();
  }

  /** Only what differs from the last thing the model was told. */
  viewChanges(): { text: string; full: boolean } {
    return this.observer.viewChanges();
  }

  /**
   * Run one action, and come back with what changed rather than whether it threw.
   *
   * This is the loop the model should not have to write by hand: revision check,
   * act, settle, diff, receipt. A model that has to remember to re-snapshot after
   * every click will forget, and the failure is silent, because a browser that
   * did something is indistinguishable from one that did nothing until you look.
   *
   * `expectedRevision` is optional and its absence is meaningful: a first action
   * on a page has nothing to compare against, and requiring a revision would
   * make the common case awkward to express.
   */
  async step<T>(
    action: (page: Page) => Promise<T>,
    options: { expectedRevision?: number | undefined; settle?: SettleOptions | undefined; timeoutMs?: number | undefined } = {},
  ): Promise<{ receipt: StepReceipt; result: T | undefined }> {
    const stepStarted = Date.now();
    const { page } = await this.ensureReady();
    /*
     * The baseline is captured against the page the model is *looking at*, which
     * is not necessarily the page it ends on.
     *
     * A program that opens a tab with `browser.newPage()` finishes on the new
     * page, and the first version captured the old one and then diffed the new
     * one against it. The result was a large, entirely spurious Removed/Added
     * list, because two different pages have nothing in common. The model would
     * read that as "the whole page changed" and act on it.
     *
     * So the starting page is remembered and the diff is anchored to it. When
     * the program stayed on the same page, this is the ordinary case and nothing
     * changes. When it moved, the receipt reports the tab change as the fact it
     * is, rather than pretending to be a diff of one page.
     */
    const startedOn = page;
    const startedUrl = page.url();
    await this.capture(startedOn);

    /*
     * The program is bounded, and what a bound can catch is precise.
     *
     * A program is model-written code, and a loop that never ends is a thing a
     * model writes by accident. What matters is that essentially all browser
     * code is *async*: every Playwright call awaits, and every `await` yields to
     * the event loop. So a runaway program is almost always of the form
     *
     *     while (true) { await page.locator("...").click(); }
     *
     * and a host timer catches that, verified.
     *
     * What it cannot catch is a synchronous spin, `while (true) {}`, because a
     * spinning loop never yields and the timer's callback never runs. Measured
     * rather than assumed: a host `setTimeout` does not fire during a
     * synchronous 1.5s loop on this runtime.
     *
     * That case is left unbounded, deliberately, because bounding it properly
     * means running the program on a worker thread that can be `terminate()`d,
     * and a Playwright `Page` cannot cross a thread boundary. The choice is
     * between an unbounded sync spin and no browser tool at all, and the sync
     * spin is rare enough to accept: it is a modelling mistake, not a plausible
     * one, and the turn's own supervisor still ends it. The eval tool solves the
     * same problem with a child process precisely because eval does not have to
     * hold a live object.
     */
    const timeoutMs = options.timeoutMs ?? BROWSER_STEP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(timeoutMs)), timeoutMs);
      // Do not hold the process open for a timer that is only a guard.
      timer.unref?.();
    });

    try {
      const { receipt, result } = await Promise.race([
        runStep(startedOn, this.observer, () => action(page), options),
        deadline,
      ]);

      /*
       * The program may have finished on a different page than it started on.
       * Recapturing there means the next `view` is about the page the model is
       * actually on, and the receipt says the tab changed.
       */
      const endedOn = (await this.ensureReady()).page;
      if (endedOn !== startedOn && !endedOn.isClosed()) {
        await this.capture(endedOn);
        return {
          result: result as T | undefined,
          receipt: {
            ...receipt,
            note:
              `The step finished on a different tab: it started at ${startedUrl} and is now at ${endedOn.url()}. ` +
              `The lines above are that page, not a diff of the one you were on.`,
          },
        };
      }
      return { receipt, result: result as T | undefined };
    } catch (error) {
      /*
       * A closed page is an ordinary state in Steel, not a failure.
       *
       * Steel's own model, read from `cdp.service.ts`: a session has one
       * `primaryPage`, `refreshPrimaryPage()` closes it and assigns a new one,
       * and every target-destroyed path is handled by checking
       * `page.isClosed()` and carrying on. Closing a page is something the API
       * does itself, on purpose, and it is a thing the model will do by writing
       * `page.close()` because that is what Playwright lets you write.
       *
       * So the response is to open another page and say so. The first version
       * reported BROWSER_DISCONNECTED, which tells the model the whole browser
       * is gone and sends it looking for a fault that does not exist, while the
       * fix is one word: continue on a new page.
       *
       * The target list is re-read from the connection rather than trusted from
       * the stale handle, which is what makes "a new page" actually new.
       */
      if (/Target (page|closed)|has been closed|Session closed|page has been closed/i.test((error as Error).message)) {
        const replaced = await this.replaceClosedPage().catch(() => undefined);
        return {
          result: undefined,
          receipt: {
            outcome: "SUCCESS",
            revision: this.observer.revision,
            after: this.observer.revision,
            navigated: false,
            urlBefore: "",
            urlAfter: replaced?.url() ?? "",
            changes: "",
            wholesale: false,
            elapsedMs: Date.now() - stepStarted,
            note: replaced
              ? `The page was closed, so the step could not be observed. A new page is open at ${replaced.url()} and the browser is connected: continue there.`
              : `The page was closed and could not be replaced, so the browser needs re-attaching.`,
          },
        };
      }

      if (error instanceof StepTimeoutError) {
        /*
         * A timeout still leaves a page, and the page is the useful part. The
         * model is told the program was cut off and shown where the browser
         * actually got to, rather than being told nothing at all.
         */
        const outline = await page.ariaSnapshot({ mode: "ai" }).catch(() => "");
        this.observer.capture({ url: page.url(), title: await page.title().catch(() => ""), snapshot: outline });
        return {
          result: undefined,
          receipt: {
            outcome: "TIMEOUT",
            revision: this.observer.revision,
            after: this.observer.revision,
            navigated: false,
            urlBefore: page.url(),
            urlAfter: page.url(),
            changes: "",
            wholesale: false,
            elapsedMs: timeoutMs,
            note: `The program was still running after ${timeoutMs}ms and was cut off. The page is as it was left. A program that never returns is usually a loop waiting on a condition that cannot become true.`,
          },
        };
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Write cookies and localStorage now, mid-script. */
  /**
   * Write this thread's cookies and storage to disk, now.
   *
   * The first version of this called `storageState()` and threw the result away,
   * which is worse than doing nothing: a caller is told the state was saved and
   * a killed process then proves it was not.
   *
   * Atomic, because the failure this guards against is a process dying
   * mid-write, and a half-written state file is a state file that fails to parse
   * on the next read. Written when a step succeeds as well, so this is for the
   * case that cannot wait: a long program that has just logged in and still has
   * work to do.
   */
  async save(): Promise<void> {
    const context = this.context;
    if (!context || !this.options.statePath) return;
    try {
      const state = await context.storageState();
      const path = this.options.statePath;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      /*
       * Mode 0600 and a rename: cookies in the clear, protected by filesystem
       * permissions the same way Chrome protects its own, and never observable
       * half-written.
       */
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      /*
       * Losing a login means signing in again; refusing to continue means the
       * agent cannot work. The state write is best-effort for exactly that
       * reason, and a caller that needs to know can read the file afterwards.
       */
    }
  }

  /**
   * The stored cookies and storage for this thread, for a fresh context.
   *
   * A read failure returns empty rather than throwing, for the same reason the
   * write swallows one: a missing or corrupt state file should cost a login, not
   * the run.
   */
  private async loadState(): Promise<Awaited<ReturnType<BrowserContext["storageState"]>> | undefined> {
    const path = this.options.statePath;
    if (!path) return undefined;
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as Awaited<ReturnType<BrowserContext["storageState"]>>;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    /*
     * Every handle is captured BEFORE anything is cleared.
     *
     * This read `const context = this.context; this.resetHandles(); ... if
     * (this.browser)`. Clearing first set `this.browser` to undefined, so the
     * `if` was never true and the browser connection was never closed. Every
     * runtime leaked one live socket to Steel's CDP port, and because node's
     * test runner waits for the event loop to drain, a suite that passed every
     * assertion hung forever and CI reported a timeout with no failing test to
     * look at.
     */
    const context = this.context;
    const browser = this.browser;
    this.resetHandles();

    /*
     * The context first: closing it releases this thread's cookies and pages,
     * and doing it before the connection goes means a half-finished close still
     * leaves the browser in a known state.
     */
    if (context) await context.close().catch(() => undefined);

    /*
     * `browser.close()` on a CDP connection detaches *this* connection. It does
     * not stop Steel's Chrome: Steel owns the process, and the browser
     * outliving a thread is what makes a login survive one. Detaching is what
     * this must do, and it must actually happen, which is the bug above.
     */
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * A page's CDP target id.
 *
 * The browser's own identifier for the tab, which is the only handle that keeps
 * meaning the same thing when tabs open and close. Playwright's `Page` object is
 * a handle to it, not an identity: two Page objects can refer to the same
 * target, and a Page can outlive the target it was created for.
 *
 * Taken through a temporary session rather than a long-lived one, so a pinning
 * check does not itself become a resource that has to be torn down.
 */
async function targetIdOf(page: Page): Promise<string | undefined> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
    return info.targetInfo?.targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * True when a value is a Playwright Page rather than something else.
 *
 * Structural because Playwright's classes are internal-prefixed and an
 * `instanceof` against a type imported across a version boundary is fragile. The
 * two fields checked are the ones a page has and a locator does not: `goto` and
 * `url`.
 */
function isPage(value: unknown): value is Page {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["goto"] === "function" && typeof candidate["url"] === "function";
}

/**
 * True when a value is a Playwright Locator.
 *
 * Distinguished from a Page by `ariaSnapshot` plus the absence of `goto`: a
 * locator can snapshot itself and cannot navigate. Checked in that order because
 * a Page also has `ariaSnapshot`, so the page test has to run first.
 */
function isLocator(value: unknown): value is import("playwright").Locator {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ariaSnapshot"] === "function" && typeof candidate["goto"] !== "function";
}

/** How long a single browser program may run before it is cut off. */
export const BROWSER_STEP_TIMEOUT_MS = 120_000;

/**
 * Raised when a program exceeded its deadline.
 *
 * A named class rather than a string check, because the catch has to tell a
 * timeout from a program that threw: one means "you wrote a loop that never
 * ends", the other means "your program hit an error", and they call for
 * different fixes from the model.
 */
export class StepTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the program was still running after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}
