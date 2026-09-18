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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { scopeBrowser, scopePage } from "./scoped-page.js";
import { isPageOwnedBy, setPageOwner } from "./page-ownership.js";
import {
  BrowserControlPausedError,
  BrowserControlRegistry,
  BrowserLeaseStaleError,
  type HandoffSummary,
} from "./control-lease.js";

import { perceive, type PerceptionResult } from "./engine.js";
import { assertNotRawChrome, assertSteelManagedEndpoint } from "./steel-endpoint.js";
import { connectWithRecovery } from "./cdp-health.js";
import { applySettingsToPage, type BrowserSettings, type PageControls } from "./session-controls.js";
import { captureIndexedDb, restoreIndexedDb, type StorageCapture } from "./storage-state.js";
import { DownloadVault, watchDownloads, type VaultFile } from "./downloads.js";
import { defaultUserAgent, nextUserAgent } from "./user-agents.js";
import type { ControlReport } from "./browser-program.js";
import { countOutline, PageObserver, type PageContentMeta, type PageViewOptions, type SnapshotStats } from "./page-view.js";
import { runStep, type SettleOptions, type StepReceipt } from "./transaction.js";
import type { TransitionDb } from "./transition-db.js";

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
  /**
   * The learned site graph, when one is shared.
   *
   * Owned by the app-server rather than by a thread, because a site's shape is
   * the same for everybody and the value of the graph comes from accumulating
   * across threads.
   */
  flows?: TransitionDb | undefined;
  /**
   * The control lease registry, shared across threads.
   *
   * Shared rather than per-runtime because the registry is keyed by thread id
   * and the gateway, which handles the take-control request, has no runtime
   * object for the thread at that moment. One registry per app-server means the
   * HTTP handler and the browser tool consult the same record.
   */
  control?: BrowserControlRegistry | undefined;
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

  /**
   * The last few steps, so an agent stuck in a loop can be told it is one.
   *
   * Measured on a live mission: the agent re-ran the same click-then-wait pair
   * thirteen consecutive times, each time writing "maybe it was transient", and
   * then re-ran the whole login-and-controls flow five more times. Every retry
   * was reasonable in isolation; nothing ever told it that the last one had been
   * identical, so there was no signal to stop on.
   *
   * A fingerprint of the program plus its outcome is enough to see that. Kept to
   * a handful and compared by exact match, so a genuinely different attempt — a
   * changed selector, a different wait — breaks the run rather than being
   * counted against the agent.
   */
  private readonly recentSteps: Array<{ fingerprint: string; outcome: string }> = [];

  /**
   * A page name that no other thread in the shared context is using.
   *
   * The counter is per-runtime, and the context is now shared, so two threads
   * both generated `page-1`: measured, a thread's page list showed `page-1` for
   * its own first tab and another `page-1` for a different thread's. The thread
   * id is part of the name because that is the thing that is unique per
   * workspace, and a name has to mean one page for `setActive` to be usable at
   * all.
   */
  private anonymousName(): string {
    this.anonymousCount += 1;
    const prefix = this.options.threadId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-6) || "t";
    return `page-${prefix}-${this.anonymousCount}`;
  }
  readonly observer = new PageObserver();
  /**
   * The learned site graph, when one is shared.
   *
   * Public and readonly: the tool reads it to learn an edge and to describe a
   * site, and there is exactly one per app-server rather than one per thread.
   */
  readonly flows: TransitionDb | undefined;

  /**
   * The control lease registry, when the caller shares one.
   *
   * Optional because most callers (tests, a one-off script) never hand control
   * to a human, and requiring a registry would mean constructing one to do
   * nothing. When it is present, every `step` is gated by it.
   */
  private readonly control: BrowserControlRegistry | undefined;

  constructor(private readonly options: ThreadRuntimeOptions) {
    this.flows = options.flows;
    this.control = options.control;
    /*
     * The vault is per thread, inside the workspace it belongs to.
     *
     * A download is the agent's own artifact: it fetched a file and will upload
     * it somewhere, possibly much later. So it goes in the thread's own
     * directory, under the workspace root the agent can already read and write,
     * rather than in a temporary directory that dies with the context or in a
     * shared folder two threads would collide in.
     *
     * The path is derived from the state file, which the app-server already
     * places per thread under the workspace, so this follows whatever layout the
     * caller chose rather than inventing a second one.
     */
    this.downloads = options.statePath
      ? new DownloadVault(join(dirname(options.statePath), basename(options.statePath, ".json"), "downloads"))
      : undefined;
  }

  /** This runtime's thread id, for lease lookups. */
  get threadId(): string {
    return this.options.threadId;
  }

  /**
   * Turn on downloads for the connected browser, which CDP does not do by itself.
   *
   * This is the root cause of every download the tool could not do, and it was
   * invisible because nothing errored: a link with
   * `Content-Disposition: attachment` simply produced no `download` event, so
   * `downloadAfter` waited its 30s and the vault stayed empty. Measured: a plain
   * attachment link on a fresh page fired no event, with raw Playwright, outside
   * this codebase entirely.
   *
   * Read out of Playwright's own source, which is where the mechanism is:
   * `CRBrowserContext.initialize()` sends `Browser.setDownloadBehavior` for a
   * context it was asked to CREATE, and it skips the command entirely when
   * `acceptDownloads` is `"internal-browser-default"`. Over `connectOverCDP` the
   * default context already exists, so it is never created by Playwright and the
   * command is never sent. The browser is left in its own default, which is to
   * hand the file to whatever the download directory setting says, with no event
   * and no path this process can reach.
   *
   * So it is sent here. `allowAndName` is what Playwright itself uses for
   * `acceptDownloads: "accept"` and it is the behaviour the vault needs: Chrome
   * keeps the file and names it by its GUID, the `download` event fires with a
   * path, and the vault copies it somewhere stable. `eventsEnabled` is what makes
   * the event fire at all.
   *
   * Best effort. A browser that refuses the command still browses; it just
   * cannot download, which is reported by `downloadAfter` when it times out
   * rather than here, where nothing is waiting for a file yet.
   */
  private async enableDownloads(browser: Browser, context: BrowserContext): Promise<void> {
    if (!this.downloads) return;
    const directory = await this.downloads.ensure().catch(() => undefined);
    if (directory === undefined) return;
    try {
      /*
       * A page-level session, because `Browser.setDownloadBehavior` is accepted
       * on any session of the connection and the browser object exposes no
       * session of its own. The first page is enough: the command is
       * browser-scoped, not page-scoped, so where it is sent from does not
       * change what it does.
       */
      const page = context.pages().find((candidate) => !candidate.isClosed());
      if (page === undefined) return;
      const session = await context.newCDPSession(page);
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: directory,
        eventsEnabled: true,
      });
      await session.detach().catch(() => undefined);
      this.downloadsEnabled = true;
    } catch {
      /* Reported later, by the wait that times out, with a message about the file. */
    }
    void browser;
  }

  /** True when the browser accepted the download command on this connection. */
  private downloadsEnabled = false;

  /**
   * Whether downloads can start a file at all on this connection.
   *
   * Public because the tool has to tell the two failures apart: a page that
   * produced no file, and a browser that was never able to. They need opposite
   * responses from the model, and read from a live mission the difference cost
   * ten tool calls clicking a link that was never the problem.
   */
  get downloadsAreEnabled(): boolean {
    return this.downloadsEnabled;
  }

  /**
   * Whether the connection to the browser is currently live.
   *
   * Answered from the handles rather than by trying to attach: a capability
   * query must not have the side effect of connecting, or asking what the
   * browser can do would be a thing that changes what it is doing.
   */
  isAttached(): boolean {
    return this.browser !== undefined && this.browser.isConnected() && this.context !== undefined;
  }

  /**
   * Attach if not already attached, and return the live handles.
   *
   * Concurrency-safe by construction: `connecting` holds the in-flight promise
   * so two calls arriving together attach once. Without that they would each
   * open a connection and one would be orphaned, holding a context that nothing
   * can reach and that never closes.
   */
  private connecting: Promise<void> | undefined;

  /**
   * Set by `close()`, so an attach that lands afterwards is not leaked.
   *
   * Attaching is asynchronous and nothing awaits it: the live pane resolves a
   * thread, which starts a connection, and the caller may stop the server before
   * that connection completes. `close()` iterates the runtimes it knows about,
   * and one whose attach has not finished has no browser to close yet, so the
   * connection would land *after* shutdown and stay open. Measured: the test
   * process exited with two sockets to Steel still ESTABLISHED, so the suite
   * passed and then hung forever.
   *
   * Checked in `attach()` after the connect resolves, where the connection is
   * the only thing that can still be undone.
   */
  private closed = false;

  /**
   * The last thing the health sweep did, if it closed a wedged page.
   *
   * Surfaced on the next tool result rather than logged and forgotten. A page
   * disappearing from under a thread is otherwise unexplainable from the agent's
   * side, and "a tab vanished and nobody said why" is exactly the kind of thing
   * that sends a model hunting for a cause that is not there.
   */
  private lastHealthNote: string | undefined;

  /**
   * Set when the last page resolution had to open a page from nothing.
   *
   * Read and cleared by the tool result, so a step that closed this thread's
   * last page is followed by a sentence saying a blank was opened and why. Read
   * from a live mission, where the agent closed all its pages and then reported
   * that "the pages keep getting recreated as about:blank" with no way to find
   * out who was creating them.
   */
  private pageWasAutoCreated = false;

  /**
   * The page the last step captured, so a follow-up read describes the same one.
   *
   * Set by the step's page-labelling callback and read for `lastCapturedPage()`,
   * which is what the tool uses to render its `PAGE:` block. Cleared when a page
   * closes, so a stale handle is never handed back to a reader.
   */
  private lastCapturedPageRef: Page | undefined;

  /** Record which page a step was about, called from the step's label callback. */
  private rememberCapturedPage(page: Page | undefined): void {
    this.lastCapturedPageRef = page;
  }

  /**
   * The active page at the start of the current step, to detect a switch.
   *
   * A program can call `browser.setActive(name)` and the bare `page` then means
   * something else for the rest of that program. The receipt did not say so, and
   * a silent change of what `page` refers to is indistinguishable from a bug:
   * read from a live mission, the agent saw a click land on a page it had not
   * meant to touch, and spent several traces on the theory that the bridge was
   * routing clicks to the wrong tab. Recording the before-and-after turns that
   * into one line.
   */
  private activeAtStepStart: Page | undefined;

  /**
   * A sentence for the receipt when the step changed which page is active.
   *
   * Returns undefined when nothing switched, which is almost always, so the
   * ordinary step carries no extra line.
   */
  private describeActiveChange(): string | undefined {
    const before = this.activeAtStepStart;
    const after = this.active;
    if (before === after) return undefined;
    const nameOf = (page: Page | undefined): string => {
      if (page === undefined) return "(none)";
      for (const entry of this.named.values()) if (entry.page === page) return entry.name;
      return page.isClosed() ? "(closed)" : page.url();
    };
    return (
      `\`page\` now means a different tab: the step switched the active page from ${nameOf(before)} to ${nameOf(after)}, ` +
      `so a bare \`page\` in a later program refers to ${nameOf(after)}.`
    );
  }

  /**
   * The page the last step was about, or undefined when it is the active one.
   *
   * The tool renders its `PAGE:` block from this rather than from the active
   * page, which is what stops the receipt and the page it describes from
   * disagreeing when a program drives a named tab without switching to it.
   */
  lastCapturedPage(): Page | undefined {
    const page = this.lastCapturedPageRef;
    if (page === undefined || page.isClosed()) return undefined;
    return page;
  }

  /**
   * Attach if needed, without resolving or changing the active page.
   *
   * The list calls need the context and nothing else, and going through
   * `ensureReady` would make a *read* do two things a read should not: pay a CDP
   * round trip to re-pin the active page, and possibly *change* which page is
   * active when the pin has gone stale. A model asking what tabs exist should
   * get an answer, not a state transition.
   */
  async ensureAttached(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.browser && this.context && !this.browser.isConnected()) this.resetHandles();
    if (!this.browser || !this.context) {
      if (!this.connecting) this.connecting = this.attach().finally(() => { this.connecting = undefined; });
      await this.connecting;
    }
    const browser = this.browser;
    const context = this.context;
    if (!browser || !context) throw new Error("the browser could not be attached");
    /*
     * A context with no pages gets one, and that belongs here rather than in the
     * reader that happens to notice.
     *
     * `browser.newContext()` creates a context with no page in it, and the page
     * was only made when something asked for the *active* page. So a thread whose
     * pane was opened before its first `browser_use` call had a browser, a
     * context, and nothing to show: `pageTargets()` returned `[]`, the pane sent
     * no tab list at all, and the viewer sat on "Session connecting" with no
     * error, because an empty list and a broken connection look the same from
     * there. Reproduced against a live thread.
     *
     * Creating it here means every reader agrees: a thread that is attached has
     * a page, which is the invariant the rest of this class already assumes
     * (`scopedHandles` throws without one, `setActive` has nothing to select).
     * The page is blank, which is the honest state of a thread that has not
     * browsed yet, and it is the page its first `browser_use` call will drive.
     */
    if (context.pages().filter((page) => !page.isClosed()).length === 0) {
      const page = await context.newPage();
      await this.claimOwn(page);
      /*
       * Settings applied to the page that was just made.
       *
       * This is the page a thread actually drives, and it is created *after*
       * `attach()` has run its own application pass, so without this line the
       * one page that matters is the one page that never gets configured: the
       * default user agent was measured not to reach it, and the page reported
       * whatever Steel launched Chrome with.
       */
      await this.applyControls(page);
      if (this.active === undefined || this.active.isClosed()) {
        this.active = page;
        this.activeTargetId = await targetIdOf(page).catch(() => undefined);
        recordTargetId(page, this.activeTargetId);
        const name = this.anonymousName();
        this.named.set(name, { name, page, openedAt: Date.now() });
      }
    }
    return { browser, context };
  }

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
    /*
     * Refused here as well as at config load, and that is not redundant.
     *
     * The runtime is constructed directly in tests and by embedders, so a
     * caller can hand it an endpoint without going through the config schema.
     * This is the last point before the socket opens, which is the only place
     * a guarantee about what we connect to can actually be kept.
     *
     * The synchronous check rejects Chrome's known ports; the probe rejects
     * Chrome on any other port by its devtools descriptor. Together they make
     * Steel the only thing this can attach to, which is the point: a raw
     * connection to Chrome would work and would bypass the layer that owns the
     * browser, so it has to be impossible rather than discouraged.
     */
    assertSteelManagedEndpoint(this.options.cdpUrl);
    await assertNotRawChrome(this.options.cdpUrl);
    /*
     * Attach, and recover from a wedged page if the handshake fails.
     *
     * `connectOverCDP` attaches to every target and waits for each one, so a
     * single wedged renderer makes the connect hang until it times out,
     * permanently and for every caller. Measured: three consecutive 120s
     * timeouts against a browser whose twelve other pages answered in under
     * 150ms, and a connect that took 11s the moment the one wedged page was
     * closed.
     *
     * The sweep runs only in the failure path, and that ordering is deliberate.
     * Sweeping first, as an earlier version did, meant a busy-but-healthy page
     * could miss its probes and be closed: on a loaded machine it closed a GitHub
     * tab a live mission was using. Nothing has to guess here: a connect fails
     * only when something is genuinely wrong, so the sweep runs exactly then.
     *
     * 45s rather than 30s, because a healthy attach on a large session is real
     * work rather than instant (11s measured for eleven pages).
     */
    const browser = await connectWithRecovery(this.options.cdpUrl, {
      timeoutMs: this.options.cdpTimeoutMs ?? 45_000,
      onClose: (report) => {
        this.lastHealthNote =
          `Closed ${report.closed.length} page(s) whose renderer had stopped answering, ` +
          `which would otherwise have made this browser impossible to attach to: ` +
          `${report.closed.map((page) => page.url || page.targetId).join(", ")}.`;
      },
    });
    /*
     * The runtime was closed while this connect was in flight.
     *
     * Closing the connection here rather than storing it is the whole point:
     * `close()` has already run and returned, so nothing else will ever visit
     * this runtime again, and an unclosed connection would outlive the server
     * that asked for it. Returning without setting the handles leaves the
     * runtime in the same closed state it was in.
     */
    if (this.closed) {
      await browser.close().catch(() => undefined);
      return;
    }

    /*
     * Steel's default context, NOT one we create, and this was measured.
     *
     * A context made with `browser.newContext()` over CDP belongs to the
     * connection that made it. When that client goes away, the context and every
     * page in it are destroyed: measured, a page holding typed input and a
     * JavaScript-set property came back as `0 pages` after a reconnect, while the
     * default context came back with all three of its pages and every value
     * intact.
     *
     * That is the whole difference between a browser that survives a client blip
     * and one that does not, and it is what "a persistent browser workspace"
     * means in practice: the pages live in the browser, not in our connection to
     * it. It also matches how Steel is designed, since its default context is the
     * one its own session and viewer talk about.
     *
     * The cost is real and was a deliberate reversal: contexts were per-thread so
     * that two threads could not read each other's cookies, and the default
     * context is shared. Steel Local is a single session (`session.service.ts`
     * holds one `activeSession`), so a deployment with several browser threads
     * was already sharing one Chrome; what changes is that the sharing is now
     * explicit rather than defeated by a reconnect. Ownership is enforced at the
     * page level instead, which is where it matters for a thread's own work: see
     * `ownedPages`.
     */
    const context = browser.contexts()[0] ?? (await browser.newContext({
      viewport: this.options.viewport ?? DEFAULT_VIEWPORT,
    }));
    if (this.options.viewport !== undefined) {
      // Applied per page rather than to the context, which is shared.
      void this.options.viewport;
    }
    await this.enableDownloads(browser, context);
    /*
     * The thread's saved cookies are seeded into the context, so a restart does
     * not cost every login. A missing file is skipped and the context keeps
     * whatever it already had, which after a reconnect is the live jar.
     */
    const state = await this.loadState();
    if (state) {
      await context.addCookies(state.cookies ?? []).catch(() => undefined);
    }
    /*
     * Checked again after the context is built, because `loadState` and
     * `newContext` both await and `close()` can land in between.
     */
    if (this.closed) {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      return;
    }
    this.browser = browser;
    this.context = context;
    context.on("close", () => {
      /*
       * A script can reach `context.close()` through the sandbox, though the
       * scoped surface refuses it. Nulling the handles here is what stops the
       * next eval finding a dead context and failing every call on it.
       */
      this.resetHandles();
    });
    /*
     * The site opening or closing a page itself.
     *
     * `window.open`, a target=_blank link and a script calling `close()` are the
     * changes nothing in this runtime performs, so nothing calls
     * `notifyPagesChanged` for them. Without these listeners the pane would show
     * a stale strip until the falling-back poll caught up, which is the exact lag
     * the push exists to remove.
     */
    context.on("page", (page) => {
      /*
       * Only a page this thread's own page opened.
       *
       * The listener fires for every page created in the context, and the
       * context is shared, so claiming unconditionally handed this thread a tab
       * another thread had just opened: measured, `a owns b's page` was true.
       *
       * The opener is the precise signal. `window.open` and a `target=_blank`
       * link record the page that opened them, and Playwright exposes it, so the
       * question "did this thread cause this tab" has an answer that does not
       * depend on timing or on which listener ran first.
       */
      void (async () => {
        const opener = await page.opener().catch(() => null);
        /*
         * `await`, and the missing await was a real bug: `owns` returns a
         * Promise, a Promise is always truthy, so this claimed every page in the
         * context regardless of its opener. The isolation tests still passed,
         * because `owns` had already recorded the right owner and the claim was
         * idempotent, which is exactly how a latent bug survives its own tests.
         */
        if (opener !== null && await this.owns(opener)) await this.claimOwn(page).catch(() => undefined);
        page.once("close", () => this.notifyPagesChanged());
        this.notifyPagesChanged();
      })();
    });

    /*
     * Downloads are watched on every page this thread has or makes.
     *
     * A download with nobody listening is discarded by Playwright, and the file
     * lives in a context-scoped temporary directory that is deleted when the
     * context closes. Both of those are silent losses, and the case they break is
     * the one this tool exists for: download an invoice here, upload it there,
     * possibly days later.
     */
    if (this.downloads) {
      for (const page of context.pages()) {
        if (!page.isClosed()) this.watchDownload(page);
      }
      context.on("page", (page) => this.watchDownload(page));
    }

    /*
     * The pages this thread had open, put back.
     *
     * After the cookies are seeded, because a page that needs a session should
     * load as the signed-in user rather than as a stranger and then be
     * navigated. A failure here never fails the attach: a thread that cannot
     * rebuild one of its tabs still needs a browser.
     */
    /*
     * Ownership is claimed before anything else looks at the page list.
     *
     * The shared default context holds every thread's tabs, so the runtime has to
     * know which ones are its own before `pageEntries` filters anything. This
     * runs first, and the window in which an unclaimed page may be adopted closes
     * as soon as it returns.
     */
    await this.claimOwnPages(context).catch(() => undefined);
    /*
     * Every page this thread owns gets its target id stamped on it, so the
     * scoping filter can answer synchronously. This is what makes
     * `scopeContext.pages()` able to exclude another thread's tabs without a CDP
     * round trip per page.
     */
    await this.decoratePages(context.pages().filter((page) => !page.isClosed())).catch(() => undefined);

    await this.restorePages(context).catch(() => undefined);
    await this.restoreNames(context).catch(() => undefined);

    /*
     * IndexedDB, restored after the pages are open.
     *
     * Order matters and this is the only correct one: IndexedDB is origin-scoped
     * and can only be written from a document on that origin, so the pages have
     * to exist and be navigated before their databases can be put back. Running
     * this before `restorePages` would find no page on any origin and skip
     * everything.
     */
    const storedIndexedDb = await this.loadIndexedDb();
    if (storedIndexedDb !== undefined) {
      this.indexedDbRestoreNotes = await restoreIndexedDb(context, storedIndexedDb).catch(() => []);
    }

    /*
     * The default settings, applied once the context exists.
     *
     * This is what makes the stealth user agent the default rather than
     * something a program has to ask for. Without it the page reports whatever
     * user agent Steel launched Chrome with, which was measured to be a string
     * from a previous session's config rather than the one this thread chose.
     * Every page is visited, because the context may have restored tabs.
     */
    for (const page of context.pages()) {
      if (!page.isClosed()) await this.applyControls(page);
    }
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
    /*
     * Only this thread's own pages are candidates, and a page is created when
     * there are none.
     *
     * This picked `context.pages()[0]` from a context that is now the shared
     * default one, so a thread with no pages of its own adopted the first tab in
     * the browser, which belonged to whoever opened it. Verified: a fresh thread
     * resolved to a page left over from an earlier run, and would have driven it.
     *
     * The page it makes itself is claimed immediately, so the ownership it needs
     * exists before anything can look at it.
     */
    const mine: Page[] = [];
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      if (await this.owns(candidate)) mine.push(candidate);
    }
    /*
     * A page is made only when the thread has none, and the fact is recorded so
     * the step can say so.
     *
     * This is the other half of the blank-page confusion: the agent closed every
     * page it owned, and the next call silently made one. It is not avoidable,
     * because a thread with no page cannot be asked to do anything, but it is
     * explainable, and `pageWasAutoCreated` is what lets the receipt explain it
     * rather than leave a tab that appeared from nowhere.
     */
    const created = mine.length === 0;
    const page = mine[0] ?? (await context.newPage());
    if (created) await this.claimOwn(page);
    this.pageWasAutoCreated = created;
    /*
     * Settings applied to whichever page this resolves to.
     *
     * This is the choke point for the page a thread actually drives: a page
     * created here, or one adopted from this thread's own restored record, is the
     * one every program uses, and nothing else configures it.
     */
    if (!page.isClosed()) await this.applyControls(page);
    this.active = page;
    /*
     * The first page is named like any other, and that is not cosmetic.
     *
     * Pages opened through `newPage` get a generated name, but the page the
     * context starts with was never named, so `pageName` on it was `undefined`.
     * A model that finds a page by URL and then calls
     * `setActive(await p.pageName)` — which is the shape the skill and the tool
     * description both suggest — passed `undefined` and got a failure for code
     * that would be right on any other tab. Observed on a live run, twice.
     *
     * Named here rather than in `attach` so a thread whose context was created
     * empty (the restore path) and a thread that attaches to an existing page
     * both get the same treatment.
     */
    if (![...this.named.values()].some((entry) => entry.page === page)) {
      const name = this.anonymousName();
      this.named.set(name, { name, page, openedAt: Date.now() });
    }
    try {
      this.activeTargetId = await targetIdOf(page);
    } catch {
      this.activeTargetId = undefined;
    }
    recordTargetId(page, this.activeTargetId);
    return page;
  }

  /** The page a bare `page` means, as the runtime has it right now. */
  get activePage(): Page | undefined {
    return this.active && !this.active.isClosed() ? this.active : undefined;
  }

  /** The CDP target id the active page is pinned to, when it is pinned. */
  activeTargetId: string | undefined;

  /**
   * Resolve and remember the active page's CDP target id.
   *
   * Exists for the live browser pane, which needs the target id to ask Steel to
   * stream that exact page and must not receive one for a page it does not own.
   * Reading `activeTargetId` directly is not enough because it is only set once
   * a step has run, and the pane is often opened in the pause between turns when
   * the page is live but nothing has pinned it yet.
   *
   * Safe to call repeatedly: it re-reads the target behind the currently active
   * page, so a stale id is corrected rather than trusted. The id is derived
   * from the page this runtime owns, which is what keeps the pane scoped: a
   * client cannot name a target id, only a thread.
   */
  async pinActiveTarget(page?: Page): Promise<string | undefined> {
    const target = page ?? (await this.ensureReady()).page;
    this.active = target;
    this.activeTargetId = await targetIdOf(target).catch(() => undefined);
    recordTargetId(target, this.activeTargetId);
    return this.activeTargetId;
  }

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
  private async replaceClosedPage(): Promise<{ page?: Page; created: boolean }> {
    this.active = undefined;
    this.activeTargetId = undefined;
    const context = this.context;
    if (!context) return { created: false };
    /*
     * Only this thread's own pages are candidates.
     *
     * This took `context.pages()[0]`, and the context is now the shared default
     * one, so a thread that closed its last page adopted whatever tab was first
     * in the browser, which belonged to another thread or to a probe. The thread
     * would then drive a page it never opened, and the tab's real owner would
     * find its page had moved under it. `owns` is the same check
     * `resolveActivePage` uses, for the same reason.
     */
    const mine: Page[] = [];
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      if (await this.owns(candidate)) mine.push(candidate);
    }
    if (mine.length > 0) {
      const page = mine[0]!;
      this.active = page;
      this.activeTargetId = await targetIdOf(page).catch(() => undefined);
      return { page, created: false };
    }
    /*
     * Nothing of this thread's is left, so one is made.
     *
     * Reported to the caller rather than done quietly, because a page appearing
     * that nobody asked for is the thing the model cannot explain. Read from a
     * live mission, where the agent closed all twelve of its pages and then
     * watched blanks "keep getting recreated", concluded "the harness always
     * keeps at least one page open", and gave up on reaching zero. It was right
     * about the mechanism and wrong about the reason: the page exists because a
     * thread with no page cannot be asked to do anything, and the next call
     * would have failed instead. Saying so turns an unexplained tab into a
     * documented one.
     */
    const page = await context.newPage().catch(() => undefined);
    if (!page) return { created: false };
    await this.claimOwn(page);
    await this.applyControls(page).catch(() => undefined);
    const name = this.anonymousName();
    this.named.set(name, { name, page, openedAt: Date.now() });
    this.active = page;
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    recordTargetId(page, this.activeTargetId);
    return { page, created: true };
  }

  /** Open a page, optionally naming it. Returns the RAW handle, for the runtime. */
  async newPage(name?: string): Promise<Page> {
    const { context } = await this.ensureReady();
    const page = await context.newPage();
    await this.claimOwn(page);
    const resolvedName = name ?? this.anonymousName();
    this.named.set(resolvedName, { name: resolvedName, page, openedAt: Date.now() });
    this.active = page;
    /*
     * Pin to the new page's target id immediately. Without this the first call
     * after opening a tab resolves by heuristics, and on a page that just opened
     * a popup those heuristics are exactly what picks the wrong one.
     */
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    recordTargetId(page, this.activeTargetId);
    this.notifyPagesChanged();
    return page;
  }

  /**
   * A subscription for "this thread's pages changed".
   *
   * The live pane needs to know when a tab is opened, closed or activated, and
   * it was discovering it with a two-second poll. That poll is why the tab strip
   * visibly lagged the agent: a program that opened a tab and finished in under
   * two seconds had its tab appear only after the fact, and a step that checked
   * the strip in between saw the old list. A push removes the delay without
   * removing the poll, which stays as a safety net for changes nothing announces
   * (a page the site closed by itself, a target that went away).
   *
   * Deliberately tiny: a set of callbacks, invoked synchronously and never
   * awaited, because the caller is a websocket handler that must not be able to
   * block the browser by being slow. A throwing listener is dropped rather than
   * propagated, since a broken viewer must not break the agent's step.
   */
  onPagesChanged(listener: () => void): () => void {
    this.pageListeners.add(listener);
    return () => this.pageListeners.delete(listener);
  }

  private readonly pageListeners = new Set<() => void>();

  /** Tell every listener the page set or the active page changed. */
  notifyPagesChanged(): void {
    for (const listener of this.pageListeners) {
      try {
        listener();
      } catch {
        /* A listener that throws is a broken viewer, not a broken browser. */
      }
    }
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
  /**
   * The thread's pages as scoped Playwright pages, each carrying its metadata.
   *
   * This is what both `browser.pages()` and a program's bare `pages()` return,
   * and they are deliberately the same call. They were not: the facade returned
   * real pages and the scope-level binding returned name/url/active records, so
   * `pages()[0].url()` worked in one place and threw "p.url is not a function"
   * in the other. A program cannot tell which of two identical-looking globals
   * it reached for, so the only safe answer is that they agree.
   *
   * The metadata is attached as non-enumerable properties rather than wrapped in
   * an object, because the page *is* the useful thing: a program wants to call
   * Playwright on it. `pageName` is what makes `browser.setActive(name)` work
   * from a page the program is holding, and `pageIndex` is what makes the
   * display order reproducible.
   *
   * Non-enumerable so the serializer does not walk them and a returned list
   * reads as a list of pages rather than a list of wrappers.
   */
  async describePages(): Promise<Page[]> {
    /*
     * Attached first, because the question cannot be answered otherwise.
     *
     * `pageEntries()` reads `this.context`, which is undefined until the runtime
     * attaches. So a caller asking "what pages does this thread have" got an
     * empty list rather than the pages it had, and a thread reopened after a
     * restart reported zero pages while its restore had in fact put them back:
     * reproduced, `pageTargets()` returned `[]` and `setActive("second")` then
     * worked, which is the two answers disagreeing about the same thread.
     */
    await this.ensureAttached();
    const out: Page[] = [];
    for (const entry of await this.pageEntries()) {
      /*
       * Settings are applied on the way out, because this is the one place that
       * visits every page the thread has. A page the site opened by itself has
       * never been through here, and a UA override does not reach it otherwise:
       * measured, a page created after the override still reported the original
       * user agent.
       */
      await this.applyControls(entry.page);
      const page = scopePage(entry.page, this.threadId);
      Object.defineProperties(page, {
        pageName: { value: entry.name, enumerable: false, configurable: true },
        pageIndex: { value: entry.index, enumerable: false, configurable: true },
        isActivePage: { value: entry.active, enumerable: false, configurable: true },
        /*
         * The CDP target id, recorded so a page that travels back through the
         * sandbox can still be identified. See `targetIdOf`.
         */
        pageTargetId: {
          value: await targetIdOf(entry.page).catch(() => undefined),
          enumerable: false,
          configurable: true,
        },
      });
      out.push(page);
    }
    return out;
  }

  /**
   * The live pages with their bookkeeping, in the order `pagesForDisplay` uses.
   *
   * The one place the name map and the live list are joined, so the display
   * form and the page form cannot disagree about which index is which.
   */
  private async pageEntries(): Promise<Array<{ page: Page; name: string | undefined; active: boolean; index: number }>> {
    /*
     * The *current* view, without attaching, and private for that reason.
     *
     * The public readers above attach first, because a caller asking about a
     * thread's pages wants the pages and not an empty list that means "not
     * attached yet". This one stays synchronous and unattached because `step`,
     * `closePage` and the pin checks read it from inside an operation that is
     * already attached, where attaching would be a no-op at best and a
     * re-entrant attach at worst.
     *
     * Private rather than merely documented: the failure mode it caused was a
     * caller reading it directly and being handed `[]`, which is
     * indistinguishable from a thread with no pages. Making it unreachable from
     * outside is what stops that from being written again.
     */
    if (!this.context) return [];
    /*
     * Only this thread's pages, from a context that is now shared.
     *
     * The context is the browser's default one so that pages outlive a client
     * reconnect, which means `context.pages()` returns every thread's tabs. A
     * thread that listed them all would offer another agent's pages to the model,
     * and `setActive` would happily switch to one. Ownership is therefore tracked
     * here, at the single place the live list is built, and it is the async
     * `owns` that decides.
     */
    const names = new Map<Page, string>();
    for (const entry of this.named.values()) {
      if (!entry.page.isClosed()) names.set(entry.page, entry.name);
    }
    const live: Page[] = [];
    for (const page of this.context.pages()) {
      if (page.isClosed()) continue;
      if (await this.owns(page)) live.push(page);
    }
    return live.map((page, index) => ({
      page,
      name: names.get(page),
      active: page === this.active,
      index,
    }));
  }

  /**
   * Whether this thread may use a page, claiming it when it is unowned.
   *
   * The id is resolved rather than read only off the object, and that is
   * load-bearing: a page created by another thread arrives here as a handle with
   * no recorded id, so an object-only check would treat a stranger's tab as
   * unowned and claim it. Resolving it through CDP is the only way to ask the
   * browser which target this handle is, and the answer is what the shared owner
   * map is keyed by.
   *
   * An unowned page is claimed only if this thread has nothing on disk yet, or
   * owns the file that page came from. Otherwise a fresh runtime for a brand new
   * thread would adopt every leftover tab in the shared browser the first time it
   * looked: measured, a second thread's `pageTargets()` returned five pages
   * belonging to earlier runs.
   *
   * A page whose id cannot be resolved at all is NOT claimed. It is almost always
   * a page in the middle of closing, and refusing it costs nothing while
   * admitting it could hand a thread a tab it does not own.
   */
  private async owns(page: Page): Promise<boolean> {
    const recorded = (page as unknown as { pageTargetId?: unknown }).pageTargetId;
    const targetId = typeof recorded === "string" && recorded.length > 0
      ? recorded
      : await targetIdOf(page).catch(() => undefined);
    if (targetId === undefined) return false;
    if (this.claimed.has(targetId)) return true;
    /*
     * The owner map is consulted first, and it is the authority: it is populated
     * from every thread's state file at first attach, so it knows about pages
     * that outlived a client without this runtime having seen them yet.
     */
    if (ThreadBrowserRuntime.owners.has(targetId)) {
      if (!isPageOwnedBy(targetId, this.threadId)) return false;
      this.claimed.add(targetId);
      return true;
    }
    /*
     * No owner recorded anywhere, and the page is not one this thread made.
     *
     * It belongs to whoever put it on screen, and this thread does not adopt it:
     * doing so is how a fresh thread came to own five leftover tabs from earlier
     * runs, measured. Ownership is claimed at creation (`claimOwn`) and at attach
     * from this thread's own record (`claimOwnPages`), so a page with neither is
     * not this thread's to use.
     */
    return false;
  }

  /**
   * Whether this runtime may claim pages nobody has recorded an owner for.
   *
   * True only while this thread is creating its own pages, and false once it has
   * attached and reconciled with what is on screen. That window is the whole
   * distinction between "a page I just opened" and "a page that was already
   * here", which is the difference between owning and stealing.
   */
  private readonly claimed = new Set<string>();

  /**
   * Where this thread's downloads are kept, when it has a workspace.
   *
   * Absent for a runtime with no state path, which is a test or a one-off script:
   * there is nowhere durable to put a file, and inventing a directory would
   * scatter downloads outside the workspace the app-server owns.
   */
  private readonly downloads: DownloadVault | undefined;

  /** Every file this thread has downloaded, for a caller that wants to report them. */
  readonly downloadedFiles: VaultFile[] = [];

  /** Attach the download handler to one page, once. */
  private watchDownload(page: Page): void {
    if (!this.downloads) return;
    watchDownloads(page, this.downloads, this.downloadedFiles);
  }

  /**
   * Everything in this thread's download vault, not only this session's.
   *
   * `downloadedFiles` holds what happened while this runtime was alive; the
   * directory holds everything the thread ever downloaded. A program asking
   * "where is the invoice I downloaded" wants the second, because the file may
   * have been fetched before a restart and be exactly the reason it is asking.
   */
  async vaultFiles(): Promise<VaultFile[]> {
    return this.downloads ? await this.downloads.list() : [];
  }

  /**
   * Record a page this thread just created as its own.
   *
   * Called from the two places a page enters this thread's world: `newPage` and
   * the first-page creation in `ensureAttached`. Claiming at the point of
   * creation is what makes ownership correct by construction, rather than a
   * window of time during which an unowned page might be adopted: the earlier
   * version closed that window at attach, before the runtime had made the page it
   * drives, so a thread could not see the page it had just created.
   *
   * A failure to resolve the id is not fatal. The page is still usable this
   * session; it simply will not be recognised after a reconnect, which is the
   * same outcome as any page whose id cannot be read.
   */
  private async claimOwn(page: Page): Promise<void> {
    const id = await targetIdOf(page).catch(() => undefined);
    if (id === undefined) return;
    setPageOwner(id, this.threadId);
    this.claimed.add(id);
    /*
     * Stamped on the page as well, so the scoping layer can decide ownership
     * without a CDP round trip. See `ownerTargetId` in `scoped-page.ts`: a proxy
     * getter cannot await, and `pages()` is read often enough that a round trip
     * per page would be felt.
     */
    recordTargetId(page, id);
    /*
     * Written to disk NOW, not at the end of the step.
     *
     * Ownership was only persisted inside `save()`, which runs after a program
     * returns. A program that opens ten tabs and is still running when the
     * app-server dies leaves a record of only the pages that existed when the
     * last save happened: measured on the mission, the file held 2 ids while
     * Chrome held 28 pages, so after the restart the thread owned almost nothing
     * and the pane showed zero tabs on a browser that was perfectly alive.
     *
     * One small file write per new page, which happens a handful of times in a
     * session, is the right price for a claim that survives a crash.
     */
    void this.persistOwnership().catch(() => undefined);
  }

  /**
   * Write the current ownership set, merging in anything already on disk.
   *
   * Merged rather than replaced, because a page that was closed during this
   * session still belongs to this thread's history: a target id that reappears
   * (a restored tab) must not be re-claimed by another thread in the gap. The
   * union is what makes the file a durable record rather than a snapshot that
   * can lose an entry to a race with a page close.
   */
  private async persistOwnership(): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    if (this.ownershipWrite === undefined) {
      this.ownershipWrite = (async () => {
        const merged = new Set<string>(this.claimed);
        /*
         * Names are written beside ownership, keyed by target id.
         *
         * They used to live only in memory, keyed by the `Page` object, which a
         * reconnect replaces: `resetHandles()` cleared the map and every recovered
         * page came back nameless, so `setActive("npm")` failed on a tab that was
         * plainly open. The mission agent hit this and reported it itself. A
         * target id is what survives a reconnect, so that is what a name has to
         * be stored against.
         */
        const names: Record<string, string> = {};
        for (const [name, entry] of this.named) {
          if (entry.page.isClosed()) continue;
          const id = (entry.page as unknown as { pageTargetId?: unknown }).pageTargetId;
          if (typeof id === "string" && id.length > 0) names[id] = name;
        }
        try {
          const parsed = JSON.parse(await readFile(ThreadBrowserRuntime.ownershipPath(path), "utf8")) as {
            targetIds?: unknown;
            names?: unknown;
          };
          if (Array.isArray(parsed.targetIds)) {
            for (const id of parsed.targetIds) if (typeof id === "string") merged.add(id);
          }
          if (parsed.names !== null && typeof parsed.names === "object") {
            for (const [id, name] of Object.entries(parsed.names as Record<string, unknown>)) {
              // A name this session has just assigned wins over the stored one.
              if (typeof name === "string" && names[id] === undefined) names[id] = name;
            }
          }
        } catch {
          /* No file yet, which is the first write. */
        }
        await this.saveOwnership([...merged], path, names);
      })().finally(() => { this.ownershipWrite = undefined; });
    }
    await this.ownershipWrite;
  }

  /** The in-flight ownership write, so two claims do not race the same file. */
  private ownershipWrite: Promise<void> | undefined;

  /**
   * Stamp every page in this thread's set with its target id.
   *
   * Called after a claim pass, so the pages a thread owns are all readable
   * synchronously by the scoping filter and by anything that has to place a page
   * without asking the browser.
   */
  private async decoratePages(pages: readonly Page[]): Promise<void> {
    for (const page of pages) {
      if (page.isClosed()) continue;
      const id = await targetIdOf(page).catch(() => undefined);
      if (id !== undefined) recordTargetId(page, id);
    }
  }

  /**
   * Register this thread's own pages, from the record it wrote last time.
   *
   * Ownership has to survive a process restart, because the shared context does:
   * a new app-server attaching to a browser whose tabs are a week old has no
   * memory of who opened what, and the state file is the only thing that does.
   * Without this, either every thread sees every tab (a leak) or every restored
   * page is unowned and unusable (a dead end). Recording it is what makes
   * "reconnect and keep working" possible at all.
   *
   * The record is a list of target ids under the thread's own state path, so two
   * threads cannot claim the same tab: whichever file names the id owns it.
   */
  /**
   * Put the names back on the pages a restart recovered.
   *
   * Ownership is keyed by target id and survives a crash, but the name map is
   * keyed by the `Page` object, which does not: after a restart every recovered
   * page came back `undefined`-named, measured, so `browser.setActive("npm")`
   * failed on a tab that was plainly open and the pane listed tabs with no
   * labels. The saved page list pairs a name with a URL, so matching on URL is
   * enough to restore it without a second identity scheme.
   */
  private async restoreNames(context: BrowserContext): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    let saved: { pages?: Array<{ url?: string; name?: string }> } | undefined;
    try {
      saved = JSON.parse(await readFile(ThreadBrowserRuntime.pagesPath(path), "utf8"));
    } catch {
      return;
    }
    for (const entry of saved?.pages ?? []) {
      if (typeof entry.url !== "string" || typeof entry.name !== "string") continue;
      if (entry.name.length === 0 || this.named.has(entry.name)) continue;
      const match = context.pages().find((page) => !page.isClosed() && page.url() === entry.url);
      if (match && ![...this.named.values()].some((existing) => existing.page === match)) {
        this.named.set(entry.name, { name: entry.name, page: match, openedAt: Date.now() });
      }
    }
  }

  private async claimOwnPages(context: BrowserContext): Promise<void> {
    const path = this.options.statePath;
    /*
     * A runtime with no state file owns nothing that is already on screen.
     *
     * This used to claim every page in the context, on the theory that a runtime
     * without a state path is the only one looking. It is not: a runtime built
     * without a state path is an ordinary second thread, and the context is now
     * the browser's shared default one, so that branch handed a brand new thread
     * every other thread's tabs. Measured: a test asserting thread isolation
     * failed with "the other thread must not see this thread's page", which is
     * exactly the leak the per-thread design exists to prevent.
     *
     * So a runtime with no record starts with nothing and claims only what it
     * creates itself, through `claimOwn` at the two creation points.
     */
    let recorded: string[] = [];
    let recordedNames: Record<string, string> = {};
    if (path) {
      try {
        const parsed = JSON.parse(await readFile(ThreadBrowserRuntime.ownershipPath(path), "utf8")) as {
          targetIds?: unknown;
          names?: unknown;
        };
        if (Array.isArray(parsed.targetIds)) recorded = parsed.targetIds.filter((id): id is string => typeof id === "string");
        if (parsed.names !== null && typeof parsed.names === "object") {
          for (const [id, name] of Object.entries(parsed.names as Record<string, unknown>)) {
            if (typeof name === "string" && name.length > 0) recordedNames[id] = name;
          }
        }
      } catch {
        /* No record yet: this thread has never had a browser. */
      }
    }
    for (const id of recorded) {
      setPageOwner(id, this.threadId);
      this.claimed.add(id);
    }
    /*
     * The names come back with the ownership, matched to live pages by target id.
     *
     * This is what makes `browser.setActive("npm")` work again after a reconnect.
     * A page whose id is recorded but which is no longer open is simply skipped:
     * a closed tab keeping its name would make the next page to reuse that id
     * answer to the wrong name.
     */
    if (Object.keys(recordedNames).length > 0) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const id = await targetIdOf(page).catch(() => undefined);
        if (id === undefined) continue;
        const name = recordedNames[id];
        if (name === undefined || this.named.has(name)) continue;
        recordTargetId(page, id);
        this.named.set(name, { name, page, openedAt: Date.now() });
      }
    }
  }

  /** Record this thread's page target ids, so a later attach can claim them. */
  private async saveOwnership(targetIds: string[], statePath: string, names: Record<string, string>): Promise<void> {
    const target = ThreadBrowserRuntime.ownershipPath(statePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    /*
     * Names ride along with ownership. Both answer "which tabs are mine and what
     * did I call them", both are keyed by target id, and both have to survive a
     * reconnect: writing them together means one file read restores a thread's
     * whole view of its browser, with no way for the two to disagree.
     */
    await writeFile(temporary, JSON.stringify({ version: 1, targetIds, names }), { mode: 0o600 });
    await rename(temporary, target);
  }

  /** Where a thread's page ownership is recorded, given its state path. */
  private static ownershipPath(statePath: string): string {
    return `${statePath}.pages-owner.json`;
  }

  /**
   * Which thread owns which CDP target, shared across runtimes.
   *
   * Static because the target ids belong to the browser, not to any one runtime,
   * and two runtimes for two threads have to agree about them. A per-runtime map
   * would let each thread believe it owned every page.
   */
  private static readonly owners = new Map<string, string>();

  /**
   * This thread's pages, each with the CDP target id that names it.
   *
   * The target id is what the live view's tab list is keyed by, because it is
   * the only identifier that means the same thing to Playwright, to Steel and
   * to the browser. A `Page` object cannot cross the wire, and an index moves
   * when a tab opens or closes.
   *
   * Resolved per page rather than cached, so a tab that was replaced by the
   * site's own `window.open` is reported under its current id rather than a
   * stale one. A page whose id cannot be read is skipped rather than given a
   * placeholder: an entry the viewer cannot connect to is worse than an absent
   * one, because it looks like a tab that will not load.
   */
  async pageTargets(): Promise<Array<{ targetId: string; url: string; title: string; name: string | undefined; active: boolean }>> {
    await this.ensureAttached();
    const entries = await this.pageEntries();
    const out: Array<{ targetId: string; url: string; title: string; name: string | undefined; active: boolean }> = [];
    for (const entry of entries) {
      const targetId = await targetIdOf(entry.page).catch(() => undefined);
      if (targetId === undefined) continue;
      out.push({
        targetId,
        url: entry.page.url(),
        title: await entry.page.title().catch(() => ""),
        name: entry.name,
        active: entry.active,
      });
    }
    return out;
  }

  /** Whether a CDP target id names one of this thread's pages. */
  async ownsTarget(targetId: string): Promise<boolean> {
    const targets = await this.pageTargets();
    return targets.some((entry) => entry.targetId === targetId);
  }

  /** Select the page a bare `page` will mean next. By name or by index. */
  async setActive(selector: string | number | Page): Promise<Page> {
    const { context } = await this.ensureReady();
    /*
     * A Promise here is almost always a missing await, and the message says so.
     *
     * `pages.find(async (p) => ...)` returns a Promise, and a program that then
     * writes `await ms.pageName` awaits the *property* of a Promise rather than
     * the call, getting `undefined`. Observed on live runs, twice. Playwright's
     * own methods are promises, so awaiting everything is the habit the skill
     * teaches; a Promise arriving at a parameter is a specific enough symptom to
     * name the cause rather than reporting `undefined` as a page name.
     */
    if (selector !== null && typeof selector === "object" && typeof (selector as { then?: unknown }).then === "function") {
      throw new Error(
        "setActive received a Promise rather than a page, which usually means a missing `await`: " +
        "`await browser.pages()` gives the list, and a list method with an async callback is itself a promise, " +
        "so `const one = await pages.find(async (p) => ...)` is the shape that works.",
      );
    }
    /*
     * A page object is accepted, and it has to be.
     *
     * `browser.pages()` returns real pages, so the natural way to switch is to
     * hold one and pass it: `await browser.setActive(pageIKept)`. That failed
     * with "no page at index [object Object]; 2 open", because the parameter was
     * only a name or an index. Observed on the first live run of the pane: the
     * model found the Microsoft page by URL, called `setActive(ms)`, and the
     * error taught it that its correct code was wrong.
     *
     * Recognised structurally rather than with `instanceof`, because a page that
     * arrived from the sandbox is a proxy for a Playwright object and Playwright
     * ships more than one class of that name.
     */
    if (isPage(selector)) {
      if (selector.isClosed()) throw new Error("that page is closed, so it cannot be made active");
      /*
       * Matched by target id, not by object identity.
       *
       * `live.includes(selector)` is always false for a page that came back
       * through the sandbox: the program holds a proxy and the host holds the
       * real object, so `===` cannot hold however correct the caller is. That
       * check refused the model's own correct program with "belongs to another
       * browser context", which is a statement about the wrong thing.
       *
       * The CDP target id is the identity that survives the boundary, and it is
       * the same one the runtime pins pages by. A page from another thread's
       * context has a different id and is still refused, which is the check that
       * was actually wanted.
       */
      const wantedId = await targetIdOf(selector).catch(() => undefined);
      if (wantedId === undefined) throw new Error("that page has no browser target, so it cannot be made active");
      /*
       * The host's own handle for that target is preferred over the caller's.
       *
       * A page that arrived through the sandbox is a proxy; the runtime's other
       * calls go through the real object, and mixing the two would mean two
       * handles for one target, drifted apart the moment either navigated. So
       * the live list is searched for the same target id and that handle is
       * adopted. When there is none — a page the program opened itself, which
       * the runtime only knows as a proxy — the caller's page is adopted and
       * pinned, because it is the only handle in existence.
       */
      for (const candidate of context.pages().filter((p) => !p.isClosed())) {
        if (candidate === selector) continue;
        if ((await targetIdOf(candidate).catch(() => undefined)) === wantedId) {
          this.active = candidate;
          this.activeTargetId = wantedId;
          return candidate;
        }
      }
      this.active = selector;
      this.activeTargetId = wantedId;
      return selector;
    }
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
    if (!page) {
      /*
       * `undefined` gets the missing-await explanation, not an index message.
       *
       * It is the signature of `await promise.pageName`: awaiting a property of
       * a Promise yields `undefined`, so the model's mistake arrives here as a
       * page name that was never a name. Reporting "no page at index undefined"
       * describes the symptom and hides the cause.
       */
      if (selector === undefined || (typeof selector === "number" && Number.isNaN(selector))) {
        throw new Error(
          "setActive received no page. This is usually a missing `await`: a list method with an async " +
          "callback returns a promise, so a property read before awaiting it is undefined. " +
          "Write `const one = await pages.find(async (p) => ...)` and then `await browser.setActive(one)`.",
        );
      }
      throw new Error(`no page at index ${selector}; ${live.length} open`);
    }
    this.active = page;
    /*
     * Re-pinned, which the first version forgot.
     *
     * `setActive(1)` moved `this.active` and left `activeTargetId` pointing at
     * the page it just moved away from, so `step` compared the new page's target
     * against the old id, decided the handle was stale, and re-resolved by
     * heuristic: the exact wrong-tab failure the pinning exists to prevent.
     */
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    this.notifyPagesChanged();
    return page;
  }

  /** Close a page, and forget it so a name is not left pointing at a corpse. */
  async closePage(page: Page): Promise<void> {
    for (const [name, entry] of this.named) {
      if (entry.page === page) this.named.delete(name);
    }
    if (this.active === page) this.active = undefined;
    await page.close().catch(() => undefined);
    this.notifyPagesChanged();
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
    const perceived = await this.perceive(target);
    this.observer.capture({
      url: target.url(),
      title: await target.title().catch(() => ""),
      snapshot: perceived.text,
      ...(perceived.note !== undefined ? { note: perceived.note } : {}),
      stats: statsOf(perceived),
      /*
       * A fallback is delivered whole. It is not a summary of the page, it is
       * the page as Playwright describes it, and trimming it removes regions
       * with no id and no way to reach them. The budget applies to the compiled
       * view, where every section is named and can be opened by id.
       */
      untrimmed: perceived.usedFallback,
    });
  }

  /**
   * Read a page through the perception engine.
   *
   * A one-line pass-through while the engine is stubbed. It stays a method
   * rather than a direct call because the compiled engine will need per-runtime
   * state here (the previous compile, for stable section and element ids across
   * revisions) and the call sites should not have to change when it lands.
   */
  private async perceive(target: Page): Promise<PerceptionResult> {
    const perceived = await perceive(target, {
      context: {
        ...(this.observer.step !== undefined ? { step: this.observer.step } : {}),
        ...(this.observer.goal !== undefined ? { goal: this.observer.goal } : {}),
      },
    });
    this.lastWasFallback = perceived.usedFallback;
    return perceived;
  }

  /** Whether the last read produced a fallback rather than a compiled view. */
  private lastWasFallback = false;

  /**
   * What the last read cost and contains.
   *
   * Counted from the text, because that is all there is while the engine is
   * stubbed: there is no compiled element list to ask. A caller that logs a step
   * reads this to see how large an observation was, and a caller that sees
   * `fallback: true` on every read knows the compiler is not running, which is
   * the signal that would otherwise be invisible.
   */
  lastStats(): { lines: number; chars: number; elements: number; sections: number; fallback: boolean } {
    const text = this.observer.currentOutline();
    return {
      lines: text.split("\n").filter((line) => line.trim().length > 0).length,
      chars: text.length,
      elements: 0,
      sections: 0,
      fallback: this.lastWasFallback,
    };
  }

  /**
   * Take the health note, if the last attach produced one.
   *
   * Read once and cleared, so the next tool result carries it and the one after
   * that does not: a notice that repeats on every step becomes noise the model
   * learns to skip, and this is worth reading exactly once, on the step where a
   * tab it was using has just disappeared.
   */
  takeHealthNote(): string | undefined {
    const note = this.lastHealthNote;
    this.lastHealthNote = undefined;
    return note;
  }

  /**
   * Take the blank-page note, if the last resolution had to open one.
   *
   * Read once and cleared, for the same reason the health note is: a sentence
   * that repeats on every step stops being read. This one matters on exactly the
   * step after a close-all, which is the step where the model is asking how many
   * pages are left.
   */
  takePageCreationNote(): string | undefined {
    if (!this.pageWasAutoCreated) return undefined;
    this.pageWasAutoCreated = false;
    const count = this.context?.pages().filter((page) => !page.isClosed()).length ?? 0;
    return (
      `This thread had no pages left, so a blank page was opened to keep it usable. ` +
      `A thread with no page cannot run a program, which is why one always exists. ` +
      `The browser now holds ${count} page(s); a closed page stays closed unless you open another.`
    );
  }

  /** The whole page, as the model should read it. */
  async view(options: PageViewOptions = {}): Promise<{
    text: string;
    truncated: boolean;
    stats: SnapshotStats;
    contentMeta: PageContentMeta;
    /** The page that was read, so a caller does not need a second round trip. */
    url: string;
  }> {
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

    /*
     * A region read stays on Playwright's own snapshot, and a whole-page read
     * compiles.
     *
     * That split is deliberate rather than a half-finished migration. Scoping to
     * one region is what keeps a 25k-character job board down to the form the
     * model is filling, and it is something Playwright's `ariaSnapshot` does
     * well and the collector does not do at all: `collectPage` reads a whole
     * document by construction, and narrowing it to a subtree would mean
     * filtering the compile afterwards, which is a different feature. A model
     * that wants a region gets one; a model that looks at the page gets the
     * compiled view, which is the case the measurement is about.
     */
    const region = scoped ?? (options.selector ? page.locator(options.selector).first() : undefined);
    if (region !== undefined) {
      const snapshot = await region.ariaSnapshot({
        mode: "ai",
        ...(options.depth ? { depth: options.depth } : {}),
      });
      // A scoped look replaces what the observer is holding, so a later diff is
      // against what the model actually saw rather than the whole page it did not.
      this.observer.capture({ url: page.url(), title: await page.title().catch(() => ""), snapshot });
      const note = options.selector ? `selector: ${options.selector}` : undefined;
      return { ...this.observer.view(note), url: page.url() };
    }

    const perceived = await this.perceive(page);
    this.observer.capture({
      url: page.url(),
      title: await page.title().catch(() => ""),
      snapshot: perceived.text,
      ...(perceived.note !== undefined ? { note: perceived.note } : {}),
      stats: statsOf(perceived),
      /*
       * A fallback is delivered whole. It is not a summary of the page, it is
       * the page as Playwright describes it, and trimming it removes regions
       * with no id and no way to reach them. The budget applies to the compiled
       * view, where every section is named and can be opened by id.
       */
      untrimmed: perceived.usedFallback,
    });
    return { ...this.observer.view(), url: page.url() };
  }

  /**
   * The page a model program is handed, and the browser that agrees with it.
   *
   * Both scoped to this thread, because a raw page's context chain reaches every
   * other thread's contexts: `page.context().browser().contexts()` returns the
   * whole browser, and agent A driving agent B's page was confirmed with exactly
   * that line. The runtime keeps the raw handles; only model code gets these.
   */
  scopedHandles(): { page: Page; browser: Browser } {
    const page = this.active;
    const context = this.context;
    if (!page || !context) throw new Error("the browser is not attached");
    const browser = page.context().browser();
    if (!browser) throw new Error("the page has no browser");
    return { page: scopePage(page, this.threadId), browser: scopeBrowser(browser, context, this.threadId) };
  }

  /**
   * The outline the observer is holding, without acknowledging it.
   *
   * Reading the page for a verifier must not count as the model having seen it,
   * or the next `viewChanges` would report nothing and the model would miss the
   * change that just happened.
   */
  async currentOutline(): Promise<string> {
    return this.observer.currentOutline();
  }

  /** Only what differs from the last thing the model was told. */
  viewChanges(): { text: string; full: boolean } {
    return this.observer.viewChanges();
  }

  /**
   * Hand this thread's browser to the human, and remember where they started.
   *
   * The start state is captured here rather than read later because "what
   * changed during the handoff" is only answerable against a *before*, and by
   * the time control is returned the before is gone. Only non-secret facts are
   * kept: URL, title, tab count. A human takes over most often to enter
   * something the agent should not hold, and recording the page's inputs would
   * put exactly those values in the transcript.
   */
  async beginHumanControl(): Promise<{ generation: number; startedAt: number }> {
    if (!this.control) throw new Error("this runtime has no control registry");
    const { context, page } = await this.ensureReady();
    this.handoff = {
      startedAt: Date.now(),
      startedUrl: page.url(),
      startedTitle: await page.title().catch(() => ""),
      startedTabs: (await this.pageEntries()).length,
      navigations: [],
    };
    /*
     * Watch the page while the human drives it.
     *
     * A passive listener, not an action: the CDP connection stays attached
     * through the handoff because detaching would let the browser be reaped and
     * lose the very state the handoff is about. Only the *destination* of a
     * navigation is recorded. The events this fires on carry no input, so a
     * password typed into a page that never navigates is never observed at all,
     * which is the property that matters.
     */
    const onNavigated = (frame: import("playwright").Frame): void => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      this.handoff?.navigations.push(url);
    };
    const onPage = (opened: import("playwright").Page): void => {
      this.handoff?.navigations.push(`(new tab) ${opened.url() || "about:blank"}`);
    };
    page.on("framenavigated", onNavigated);
    context.on("page", onPage);
    this.handoffListeners = () => {
      page.off("framenavigated", onNavigated);
      context.off("page", onPage);
    };
    const lease = this.control.takeControl(this.threadId);
    return { generation: lease.generation, startedAt: lease.since };
  }

  /**
   * Take control back, drop everything the agent was holding, and read the page
   * fresh.
   *
   * This is the resync, and the order matters: the cached view is discarded
   * *before* the new one is read, because the agent is about to be told the
   * state may have changed and a view that survived the handoff would let it
   * diff against a page that no longer exists. Returning the summary as well as
   * refreshing means the caller can tell the model what happened in one step
   * rather than leaving it to notice a silent difference.
   */
  async endHumanControl(): Promise<{ generation: number; summary: HandoffSummary }> {
    if (!this.control) throw new Error("this runtime has no control registry");
    const started = this.handoff;
    const { page } = await this.ensureReady();
    const endedUrl = page.url();
    const endedTitle = await page.title().catch(() => "");
    const endedTabs = (await this.pageEntries()).length;

    /*
     * Invalidate first. `observer.reset()` drops the held outline and returns
     * the revision to zero, so the next read is a full page rather than a delta
     * against pre-handoff state, and any action still holding a pre-handoff
     * revision is refused by the ordinary stale-revision check as well as by the
     * generation check below. Two independent guards on the same race, because
     * the failure they prevent is a click landing in a page the human is typing
     * into.
     */
    this.observer.reset();
    await this.capture(page);

    const lease = this.control.returnControl(this.threadId);
    const tabDelta = endedTabs - (started?.startedTabs ?? endedTabs);
    const urlChanged = (started?.startedUrl ?? endedUrl) !== endedUrl;
    const titleChanged = (started?.startedTitle ?? endedTitle) !== endedTitle;
    /*
     * The change list is built from the facts, not from the raw event stream.
     * Consecutive navigations are collapsed because a login flow that
     * redirects twice is one event to the reader, and the destinations are
     * listed because they say *where* the human went without saying what they
     * typed to get there.
     */
    const changes: string[] = [];
    const destinations = [...new Set(started?.navigations ?? [])];
    if (destinations.length > 0) {
      changes.push(`the page navigated during the handoff, through: ${destinations.join(" -> ")}`);
    }
    if (urlChanged) changes.push(`the page ended somewhere else: ${started?.startedUrl ?? "?"} -> ${endedUrl}`);
    if (titleChanged && !urlChanged) changes.push(`the page title changed: "${started?.startedTitle ?? ""}" -> "${endedTitle}"`);
    if (tabDelta > 0) changes.push(`the user opened ${tabDelta} new tab${tabDelta === 1 ? "" : "s"}`);
    if (tabDelta < 0) changes.push(`the user closed ${-tabDelta} tab${tabDelta === -1 ? "" : "s"}`);
    if (changes.length === 0) changes.push("nothing observable changed while the user had control");

    const summary: HandoffSummary = {
      startedAt: started?.startedAt ?? lease.since,
      endedAt: Date.now(),
      startedUrl: started?.startedUrl ?? endedUrl,
      endedUrl,
      urlChanged,
      startedTitle: started?.startedTitle ?? endedTitle,
      endedTitle,
      titleChanged,
      tabDelta,
      changes,
    };
    this.handoff = undefined;
    this.handoffListeners?.();
    this.handoffListeners = undefined;
    return { generation: lease.generation, summary };
  }

  /** Where the human started, while they have control. */
  private handoff:
    | { startedAt: number; startedUrl: string; startedTitle: string; startedTabs: number; navigations: string[] }
    | undefined;
  /** Detaches the handoff listeners. Held so a return removes exactly what a take added. */
  private handoffListeners: (() => void) | undefined;

  /** Whether a human currently owns this thread's browser. */
  humanHasControl(): boolean {
    return this.control?.lease(this.threadId).owner === "human";
  }

  /**
   * The current control lease, for the pane's status line.
   *
   * Returns an agent-owned lease when this runtime has no registry, so a caller
   * that only needs to display the state does not have to handle "unknown": a
   * thread that cannot hand control is a thread the agent owns.
   */
  controlLease(): { owner: "agent" | "human"; generation: number; since: number } {
    return this.control?.lease(this.threadId) ?? { owner: "agent", generation: 0, since: 0 };
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
    options: {
      expectedRevision?: number | undefined;
      settle?: SettleOptions | undefined;
      timeoutMs?: number | undefined;
      /**
       * The control generation this action was decided under.
       *
       * Checked here rather than at the tool boundary because this is the one
       * function every agent action passes through, and the race it closes is
       * between the decision and the doing: the model decides a click, the user
       * takes control, and the click would otherwise land on the page the human
       * is now driving. A refusal here is the earliest point the runtime can
       * tell that the world moved.
       */
      controlGeneration?: number | undefined;
    } = {},
  ): Promise<{ receipt: StepReceipt; result: T | undefined }> {
    const stepStarted = Date.now();
    /*
     * Refuse before touching the page, and before `ensureReady`, so a paused
     * thread does not even reattach. The lease lives on the runtime because the
     * runtime is per-thread and this check must use the same thread identity the
     * handoff used.
     */
    if (this.control) {
      const verdict = this.control.checkAgentAction(this.threadId, options.controlGeneration);
      if (!verdict.ok) {
        if (verdict.reason === "stale-generation") {
          throw new BrowserLeaseStaleError(options.controlGeneration ?? -1, this.control.lease(this.threadId).generation);
        }
        throw new BrowserControlPausedError(this.control.lease(this.threadId));
      }
    }
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
    this.activeAtStepStart = page;
    /*
     * Every page's URL before the program runs, so the ones it changed can be
     * named even when none of them is the active page.
     *
     * This is the fix for the failure that cost a mission twenty calls. A program
     * may drive a tab it selected by URL —
     *
     *     const ti = pages.find(p => p.url().includes("the-internet..."));
     *     await ti.goto("/login");
     *
     * — and the receipt was rendered from the *active* page, which was a
     * different tab that had not moved. So the receipt said "the page did not
     * change" and "URL unchanged", the model concluded its click had done
     * nothing, and it spent twenty calls investigating a click that had in fact
     * worked, on a page it was never looking at.
     *
     * `pageLabel` above could not catch this: it labels the page the step
     * captured, and the captured page is the active one by definition. What
     * catches it is comparing every page before and after, which is cheap (the
     * thread owns a handful) and is the only way to report work done somewhere
     * other than where the model happens to be looking.
     */
    const urlsBefore = new Map<Page, string>();
    for (const candidate of this.context?.pages() ?? []) {
      if (!candidate.isClosed()) urlsBefore.set(candidate, candidate.url());
    }
    await this.capture(startedOn);

    /*
     * Label a receipt with the page it is about when that is not the active one.
     *
     * A program may drive a named tab without making it active, and the receipt
     * is rendered from the page the step captured rather than from the active
     * one. Without this the model was told `URL: about:blank` while its program
     * was filling a form on a named tab, thirteen times in a row on one mission,
     * and had to infer its own work had landed from the value it returned.
     *
     * The active page is deliberately left unlabelled: naming the page a model is
     * already looking at is noise on every single step.
     */
    const pageLabel = (target: Page): string | undefined => {
      /*
       * Remembered as well as labelled, so the step's `PAGE:` block reads the
       * same page the receipt describes. Without this the block was rendered
       * from the active page while the receipt was about the captured one, and
       * the two disagreed: read from a live mission, a receipt said the page was
       * `/ajax` while the `PAGE:` block below it showed `/dynamicid`, and the
       * agent spent a trace trying to work out which tab it was on.
       */
      this.rememberCapturedPage(target);
      if (target === this.active) return undefined;
      for (const entry of this.named.values()) {
        if (entry.page === target) return `${entry.name} (${entry.page.isClosed() ? "closed" : entry.page.url()})`;
      }
      return target.isClosed() ? "an unnamed page (closed)" : `an unnamed page (${target.url()})`;
    };

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
        /*
         * The transaction captures through this runtime rather than through
         * Playwright directly, so every capture in the loop is the same
         * representation: the compile when it works, the snapshot when it does
         * not. A step that captured one way before the action and the other way
         * after would diff two different descriptions of the page and report the
         * whole thing as changed.
         */
        runStep(startedOn, this.observer, () => action(page), {
          ...options,
          capture: (target) => this.capture(target),
          pageLabel,
        }),
        deadline,
      ]);

      /*
       * The program may have finished on a different page than it started on.
       * Recapturing there means the next `view` is about the page the model is
       * actually on, and the receipt says the tab changed.
       */
      /*
       * Name any of this thread's pages the program moved, other than the one
       * the receipt is about.
       *
       * This is what turns "the page did not change" into "the page did not
       * change, and the tab you navigated did: it is now at /login". Without it
       * a program that acts on a tab it selected by URL gets a receipt about a
       * different tab, and the agent has no way to tell a working click from a
       * dead one. Prepared here and appended to whichever note the branches
       * below produce, because every one of them needs it.
       */
      const movedElsewhere: string[] = [];
      for (const candidate of this.context?.pages() ?? []) {
        if (candidate.isClosed()) continue;
        const before = urlsBefore.get(candidate);
        if (before === undefined) continue;
        const after = candidate.url();
        if (after === before) continue;
        const name = [...this.named.values()].find((entry) => entry.page === candidate)?.name;
        movedElsewhere.push(`${name ?? "an unnamed tab"} (${before} -> ${after})`);
      }
      if (movedElsewhere.length > 0) {
        receipt.otherTabsMoved = true;
        /*
         * The page the step actually acted on becomes what a follow-up read
         * describes.
         *
         * `lastCapturedPage` is what the tool renders its `PAGE:` block from,
         * and it was set to the page the transaction captured — the active one.
         * So a program that drove a named tab got a receipt about that tab's
         * *identity* in its note and the active page's *contents* in the block
         * below it, which is the contradiction the mission spent twenty calls
         * on. Pointing the capture at the tab that moved means the block shows
         * what changed, which is what the model was asking for.
         */
        for (const candidate of this.context?.pages() ?? []) {
          if (candidate.isClosed()) continue;
          const before = urlsBefore.get(candidate);
          if (before !== undefined && candidate.url() !== before) {
            /*
             * The pointer only. The capture below is the tool's own read, from
             * `lastCapturedPage()`, so it reads this page fresh rather than
             * diffing against a snapshot taken here.
             */
            this.rememberCapturedPage(candidate);
            break;
          }
        }
      }
      if (movedElsewhere.length > 0 && receipt.urlAfter === receipt.urlBefore) {
        /*
         * Only when the receipt's own page did not move. If it did, the receipt
         * already describes a navigation and adding a second one would read as a
         * contradiction rather than as extra information.
         */
        receipt.note =
          `${receipt.note} ` +
          `Other tabs this thread owns changed during the step even though this one did not: ` +
          `${movedElsewhere.join("; ")}. The program acted through a page handle rather than the active page.`;
      }

      const endedOn = (await this.ensureReady()).page;
      const movedTabs = endedOn !== startedOn && !endedOn.isClosed();
      if (movedTabs) await this.capture(endedOn);
      /*
       * A program that called `setActive` changed what a bare `page` means, and
       * the receipt says so.
       *
       * This is not the same as finishing on a different tab: the program ended
       * on the tab it started on, and only the *active* page moved, so `movedTabs`
       * is false and the note below never ran. Read from a live mission: the
       * agent switched the active page mid-program, saw a later click land
       * somewhere it did not expect, and spent traces on the theory that the
       * bridge was misrouting clicks. One sentence here removes that theory.
       */
      const activeChange = this.describeActiveChange();
      if (activeChange !== undefined) {
        return {
          result: result as T | undefined,
          receipt: { ...receipt, note: `${receipt.note} ${activeChange}` },
        };
      }
      if (movedTabs) {
        /*
         * The note reports the tab change, but only replaces the receipt's own
         * note when the step succeeded.
         *
         * This overwrote the note unconditionally, and a failed step that also
         * changed tabs therefore arrived as `POSTCONDITION_FAILED` with a
         * sentence about tabs and nothing about the failure: the reason the step
         * failed was the one thing the receipt no longer said. Read from a live
         * mission, where the agent got "The step finished on a different tab: it
         * started at about:blank and is now at about:blank" for a step whose
         * program had thrown, and had to guess what had gone wrong.
         *
         * A failure's own message is the receipt's most important line, so the
         * tab fact is appended to it rather than put in its place.
         */
        const tabNote =
          `The step finished on a different tab: it started at ${startedUrl} and is now at ${endedOn.url()}. ` +
          `The lines above are that page, not a diff of the one you were on.`;
        /*
         * The receipt's own note is kept when it carries something the tab
         * sentence does not. A failure's message is the obvious case, and the
         * "other tabs changed" line is the same kind of fact: dropping either
         * would take away the only sentence explaining what the step actually
         * did. Only a bare success note is replaced, because then the tab change
         * *is* the story and the old line ("the page changed without
         * navigating") is describing a page the model is no longer on.
         */
        const failed = receipt.outcome !== "SUCCESS" && receipt.outcome !== "NO_CHANGE";
        const keepOwnNote = failed || movedElsewhere.length > 0;
        return {
          result: result as T | undefined,
          receipt: {
            ...receipt,
            note: keepOwnNote ? `${receipt.note} ${tabNote}` : tabNote,
          },
        };
      }
      /*
       * Persist after the step, which is what `save()`'s own comment always
       * said happened and did not.
       *
       * The case this covers that the save-on-close cannot: a step that just
       * logged in, on a thread that then sits idle for an hour. Without this the
       * cookies exist only in the live context, and a crash, a restart or a
       * reaper pass costs the login. Best-effort and awaited, because it is a
       * small file write and a step is already hundreds of milliseconds.
       */
      await this.save().catch(() => undefined);
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
        const replaced = await this.replaceClosedPage().catch(() => ({ created: false }) as { page?: Page; created: boolean });
        return {
          result: undefined,
          receipt: {
            outcome: "SUCCESS",
            revision: this.observer.revision,
            after: this.observer.revision,
            navigated: false,
            urlBefore: "",
            urlAfter: replaced.page?.url() ?? "",
            changes: "",
            wholesale: false,
            elapsedMs: Date.now() - stepStarted,
            note: replaced.page === undefined
              ? `The page was closed and could not be replaced, so the browser needs re-attaching.`
              : replaced.created
                ? /*
                   * Named as created, because it was, and a page the model did
                   * not open is otherwise a mystery. The count of its remaining
                   * pages is the fact the model is usually trying to establish
                   * when it closes things.
                   */
                  `The page was closed, so the step could not be observed. This thread had no pages left, so one was opened for you at ${replaced.page.url()}; nothing else was touched.`
                : `The page was closed, so the step could not be observed. Another of this thread's pages is now active at ${replaced.page.url()}: continue there.`,
          },
        };
      }

      if (error instanceof StepTimeoutError) {
        /*
         * A timeout still leaves a page, and the page is the useful part. The
         * model is told the program was cut off and shown where the browser
         * actually got to, rather than being told nothing at all.
         */
        await this.capture(page).catch(() => undefined);
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

  /**
   * The browser settings this thread is running under.
   *
   * Held here rather than read from the page, because the page cannot be asked:
   * `Emulation.setUserAgentOverride` has no getter, and a setting that was
   * applied to one page is not visible from another. The runtime is the only
   * object that knows what was asked for, so it owns the record.
   *
   * Starts with a stealth user agent rather than none. Presenting as automation
   * is the difference between a page and an interstitial, and a model should not
   * have to know to ask for it.
   */
  private settings: BrowserSettings = { userAgent: defaultUserAgent() };

  /**
   * Bumped whenever a setting changes, so an already-configured page is not
   * reconfigured on every call. See `PageControls.appliedVersion`.
   */
  private settingsVersion = 0;

  /** Per-page control channels, so each page's CDP session is created once. */
  private readonly pageControls = new WeakMap<Page, PageControls>();

  /**
   * What could not be put back from the saved IndexedDB.
   *
   * Kept so a caller can say so rather than reporting a clean restore. A
   * database that failed to open is the difference between a thread that is
   * signed in and one that will fail a login wall on its next action, and the
   * agent is told which it is.
   */
  private indexedDbRestoreNotes: string[] = [];

  /**
   * The settings in force, for a program that asks.
   *
   * Returned as a plain object rather than the interface, because it crosses the
   * sandbox boundary as data and the caller reads it as such. The bandwidth
   * block is copied so a program cannot mutate the runtime's own record by
   * holding on to what it was handed.
   */
  currentSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      userAgent: this.settings.userAgent,
      timezone: this.settings.timezone,
      viewport: this.settings.viewport,
      fullscreen: this.settings.fullscreen,
      blockAds: this.settings.blockAds,
    };
    if (this.settings.bandwidth) out["bandwidth"] = { ...this.settings.bandwidth };
    if (this.settings.userPreferences) out["userPreferences"] = { ...this.settings.userPreferences };
    return out;
  }

  /**
   * Apply the current settings to a page and remember its control channel.
   *
   * Called for the active page on attach, and for every page the runtime hands
   * out, because a UA override does not propagate to a page created afterwards:
   * measured, a new page in the same context still reported the original user
   * agent. Applying on the way out rather than on creation is what covers the
   * pages a site opens by itself.
   */
  async applyControls(page: Page): Promise<void> {
    const context = this.context;
    if (!context || page.isClosed()) return;
    try {
      const controls = await applySettingsToPage(
        page,
        context,
        () => this.settings,
        this.pageControls.get(page),
        this.settingsVersion,
      );
      this.pageControls.set(page, controls);
    } catch {
      /*
       * A page that closed between the check and the call is not a failure: the
       * settings belong to a page that is gone, and the caller is about to find
       * out when it uses it.
       */
    }
  }

  /**
   * Change this thread's browser settings.
   *
   * Every setting is applied to the pages this thread currently has open, and
   * recorded so pages opened later get it too. The report separates what is live
   * from what waits for the next launch, because `userPreferences` is a Chrome
   * profile setting with no per-page equivalent and claiming it applied would be
   * a lie the model builds on.
   */
  async setSettings(patch: BrowserSettings): Promise<ControlReport> {
    const applied: string[] = [];
    const nextLaunch: string[] = [];

    if (patch.userAgent !== undefined) {
      this.settings.userAgent = patch.userAgent;
      applied.push("userAgent");
    }
    if (patch.timezone !== undefined) {
      this.settings.timezone = patch.timezone;
      applied.push("timezone");
    }
    if (patch.viewport !== undefined) {
      this.settings.viewport = patch.viewport;
      /*
       * Fullscreen and an explicit viewport are contradictory, so setting one
       * clears the other rather than leaving whichever was set last to win by
       * accident.
       */
      delete this.settings.fullscreen;
      applied.push("viewport");
    }
    if (patch.fullscreen !== undefined) {
      this.settings.fullscreen = patch.fullscreen;
      if (patch.fullscreen) delete this.settings.viewport;
      applied.push("fullscreen");
    }
    if (patch.blockAds !== undefined) {
      this.settings.blockAds = patch.blockAds;
      applied.push("blockAds");
    }
    if (patch.bandwidth !== undefined) {
      this.settings.bandwidth = { ...this.settings.bandwidth, ...patch.bandwidth };
      applied.push("bandwidth");
    }
    if (patch.mobile !== undefined) {
      this.settings.mobile = patch.mobile;
      applied.push("mobile");
    }
    if (patch.proxy !== undefined) {
      /*
       * A proxy is per *context*, not per page, and there is no CDP command that
       * re-points a live one. Changing it means rebuilding this thread's context,
       * which loses its pages, so it is reported rather than applied: a model
       * that is told "applied" would carry on using the old route and never
       * understand why its traffic is not proxied.
       */
      this.settings.proxy = patch.proxy;
      nextLaunch.push("proxy");
    }
    if (patch.userPreferences !== undefined) {
      this.settings.userPreferences = patch.userPreferences;
      /*
       * Chrome reads user preferences when it starts, from the profile. There is
       * no per-page command that changes them, so this is recorded and reported
       * as deferred rather than silently doing nothing.
       */
      nextLaunch.push("userPreferences");
    }

    /*
     * Applied to the live pages. A failure on one page is not fatal to the
     * others: a page that navigated away mid-call should not stop the setting
     * from reaching the pages that are still open.
     */
    if (applied.length > 0) this.settingsVersion++;
    const { context } = await this.ensureReady();
    for (const page of context.pages()) {
      if (!page.isClosed()) await this.applyControls(page);
    }

    return {
      applied,
      nextLaunch,
      current: this.currentSettings(),
      ...(nextLaunch.length > 0
        ? { note: `${nextLaunch.join(", ")} applies when the browser next starts, not to the open page.` }
        : {}),
    };
  }

  /**
   * Switch to the next user agent in the pool.
   *
   * The rotation a block calls for. The current string is remembered so the next
   * pick cannot land back on it, which is what makes a rotation a change rather
   * than a retry.
   */
  async rotateUserAgent(reason?: string): Promise<ControlReport> {
    const previous = this.settings.userAgent;
    const next = nextUserAgent(previous);
    const report = await this.setSettings({ userAgent: next });
    return {
      ...report,
      note:
        `${reason ? `${reason}, so ` : ""}the user agent was rotated from ${previous ?? "(none)"} to ${next}. ` +
        `A site that refused the previous one may accept this one; reload the page to find out.`,
    };
  }

  /**
   * Replace a page's renderer by navigating it out and back.
   *
   * The fix for a page that renders, reads and navigates, but silently drops
   * every trusted input event. Measured on a live mission: clicks returned
   * without error and dispatched nothing, typing into a focused field did
   * nothing, and Tab never moved focus, on one origin only, while the same API
   * worked on another tab in the same browser. The agent spent thirty trace
   * blocks proving the page's JavaScript was fine before finding this by
   * accident, and the fact that it works is worth naming rather than
   * rediscovering.
   *
   * A cross-origin navigation replaces the renderer process, which is what
   * clears the state. Cookies and storage live in the context, not the renderer,
   * so a logged-in session survives; what is lost is anything the page held in
   * memory, which is the part that was broken.
   *
   * The page is returned to the URL it was on, so the caller can carry on.
   */
  async recover(target?: Page): Promise<ControlReport> {
    /*
     * A target, because the page that stops taking input is usually not the
     * active one.
     *
     * The mission drove a tab it had selected by URL, so `page` meant a
     * different page entirely; recovering the active page would have replaced
     * the renderer of a page that was working and left the broken one alone.
     */
    const page = target ?? (await this.ensureReady()).page;
    if (page.isClosed()) {
      return {
        applied: [],
        nextLaunch: [],
        current: this.currentSettings(),
        note: "that page is already closed, so there is no renderer to replace.",
      };
    }
    const url = page.url();
    if (url.startsWith("about:") || url.length === 0) {
      return {
        applied: [],
        nextLaunch: [],
        current: this.currentSettings(),
        note: "the active page is blank, so there is no renderer to replace; navigate somewhere first.",
      };
    }
    try {
      /*
       * `about:blank` first, because a same-origin reload keeps the renderer
       * process and would not clear the state that is broken. The two hops are
       * the point, not a side effect.
       */
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.capture(page).catch(() => undefined);
      return {
        applied: ["renderer"],
        nextLaunch: [],
        current: this.currentSettings(),
        note:
          `the page's renderer was replaced and it is back at ${url}. ` +
          `Trusted input should work now; retry the click that was failing. ` +
          `Cookie state is kept, so a login survives this.`,
      };
    } catch (error) {
      return {
        applied: [],
        nextLaunch: [],
        current: this.currentSettings(),
        note: `the renderer could not be replaced: ${(error as Error).message.split("\n")[0]}. The page is at ${page.url()}.`,
      };
    }
  }

  /**
   * Record what a step did, and answer with a warning when it is repeating.
   *
   * Called by the tool with the program's source and the outcome it produced.
   * The fingerprint is the source with whitespace collapsed, so a model that
   * reformats its own program is not treated as having tried something new, and
   * the outcome is part of the key, so "the same click that worked" and "the same
   * click that failed" are different histories.
   *
   * Returns a sentence at exactly the point where a person would say it: the
   * third time the same thing produced the same result. Not the second — a retry
   * after a transient failure is reasonable — and not the tenth, by which point
   * the mission has already spent its budget. The message names what has not
   * changed and what to change, rather than only reporting the count, because
   * "you have done this three times" is a fact and "nothing about the page has
   * changed between them" is the reason to act differently.
   */
  noteStepOutcome(code: string, outcome: string): string | undefined {
    const fingerprint = code.replace(/\s+/g, " ").trim();
    this.recentSteps.push({ fingerprint, outcome });
    if (this.recentSteps.length > 8) this.recentSteps.shift();

    const repeats = this.recentSteps.filter(
      (entry) => entry.fingerprint === fingerprint && entry.outcome === outcome,
    ).length;
    if (repeats < 3) return undefined;
    /*
     * Only warn on the third and then every third, so the sentence stays a
     * signal rather than becoming a line the model scrolls past.
     */
    if (repeats % 3 !== 0) return undefined;
    return (
      `LOOP: this is the ${repeats}${ordinalSuffix(repeats)} time the same program has produced ${outcome} on this page. ` +
      `Retrying it unchanged will keep producing it. Change something: a different locator, ` +
      `\`probeInput()\` to check whether the page is still accepting input, \`recover()\` if it is not, ` +
      `or a different route to the goal.`
    );
  }

  /**
   * Whether this page is hearing input at all.
   *
   * The question the model had to answer for itself, over thirteen tool calls,
   * and could not: it registered document-level listeners, clicked, checked the
   * counter, tried keyboard input and Tab focus, compared coordinates with
   * `elementFromPoint`, and finally gave up and reported the browser broken.
   * Every one of those steps was the model rebuilding a probe that belongs here.
   *
   * The probe is small: install a listener, deliver one real mouse event through
   * CDP at a harmless point, and see whether the page heard it.
   * `Input.dispatchMouseEvent` is the same path a `locator.click()` takes.
   *
   * Deliberately not a click on any element: a probe must not change the page it
   * is asking about. The point is the viewport corner, which no layout puts a
   * control at, and the listener is removed before returning.
   *
   * ## What this does and does not prove
   *
   * Measured against the live browser: a page whose main thread is blocked
   * STILL reports delivered, because Chrome queues the event and dispatches it
   * when the thread frees up. A backgrounded tab reports delivered. Neither is
   * the failure mode, and this probe says so honestly rather than pretending to
   * detect them.
   *
   * What it does detect is the case the mission actually hit: the program's
   * `page` and the click landing on two different tabs, which is a platform bug
   * fixed in `BrowserProgramHost`, and any state where input is genuinely not
   * reaching a document at all. A `false` here is real; a `true` means the page
   * itself is not the reason a click did nothing.
   */
  async probeInput(target?: Page): Promise<{ delivered: boolean; note: string }> {
    const page = target ?? (await this.ensureReady()).page;
    if (page.isClosed()) return { delivered: false, note: "that page is closed." };
    try {
      await page.evaluate("window.__reaperProbe = 0; window.addEventListener('mousedown', () => { window.__reaperProbe += 1; }, true);");
      /*
       * A real mouse event at the top-left corner, inside the viewport and over
       * nothing a page would put a control on.
       */
      await page.mouse.move(2, 2);
      await page.mouse.down();
      await page.mouse.up();
      const heard = await page.evaluate("window.__reaperProbe");
      await page.evaluate("window.removeEventListener('mousedown', () => {}, true);").catch(() => undefined);
      const delivered = typeof heard === "number" && heard > 0;
      return {
        delivered,
        note: delivered
          ? "the page received the probe click, so its renderer is accepting input. If an earlier click did nothing, the cause is the locator or the element, not the page."
          : "the page did NOT receive the probe click, so its renderer has stopped accepting input. Clicks and typing will keep doing nothing on this page. Call recover(target) to replace the renderer, then retry.",
      };
    } catch (error) {
      return { delivered: false, note: `the probe could not run: ${(error as Error).message.split("\n")[0]}` };
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
      /*
       * IndexedDB beside the Playwright state, because Playwright's does not
       * carry it. Verified: `storageState()` returns cookies and localStorage
       * only, and IndexedDB is where a large share of modern apps keep the
       * session token. Written first so a failure in the larger copy does not
       * lose the cookies.
       */
      const indexedDb = await captureIndexedDb(context).catch(() => undefined);
      if (indexedDb !== undefined) await this.saveIndexedDb(indexedDb);
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
      /*
       * The pages are saved beside the cookies, in their own file.
       *
       * Cookies alone restore a login but not the *work*: a thread that had
       * three tabs open, one of them a search result it was part-way through
       * reading, came back as a single blank page after a restart and the agent
       * had to redo the navigation that got it there. The tabs are the thread's
       * working state, and they were the one part of it nothing persisted.
       *
       * A sibling file rather than a wrapper around the storage state, because
       * `statePath` is fed straight to `newContext({ storageState })` and has to
       * stay a valid Playwright storage state. Folding the page list into it
       * would mean shaping a file a library parses to suit us.
       */
      await this.savePages(path);
    } catch {
      /*
       * Losing a login means signing in again; refusing to continue means the
       * agent cannot work. The state write is best-effort for exactly that
       * reason, and a caller that needs to know can read the file afterwards.
       */
    }
  }

  /** Where a thread's open pages are recorded, given its storage-state path. */
  private static pagesPath(statePath: string): string {
    return `${statePath}.pages.json`;
  }

  /**
   * Where a thread's IndexedDB is recorded.
   *
   * A sibling of the storage state rather than a field inside it, for the same
   * reason the page list is: `statePath` is handed straight to
   * `newContext({ storageState })` and has to stay a valid Playwright storage
   * state. Adding a field Playwright does not know about would be shaping a file
   * a library parses to suit us.
   */
  private static indexedDbPath(statePath: string): string {
    return `${statePath}.indexeddb.json`;
  }

  /** Write the captured IndexedDB, atomically and private. */
  private async saveIndexedDb(capture: StorageCapture): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    const target = ThreadBrowserRuntime.indexedDbPath(path);
    /*
     * Nothing to restore means the file is removed rather than left behind.
     *
     * A stale file would restore a database the thread has since cleared, which
     * is the same class of bug as a stale cookie: the session looks signed in
     * and the app disagrees.
     */
    if (capture.origins.length === 0) {
      await rm(target, { force: true }).catch(() => undefined);
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, ...capture }), { mode: 0o600 });
    await rename(temporary, target);
  }

  /** Read the saved IndexedDB, or undefined when there is none to restore. */
  private async loadIndexedDb(): Promise<StorageCapture | undefined> {
    const path = this.options.statePath;
    if (!path) return undefined;
    try {
      const raw = await readFile(ThreadBrowserRuntime.indexedDbPath(path), "utf8");
      const parsed = JSON.parse(raw) as StorageCapture & { version?: number };
      if (!Array.isArray(parsed.origins)) return undefined;
      return { origins: parsed.origins, skipped: parsed.skipped ?? [] };
    } catch {
      return undefined;
    }
  }

  /**
   * Record the thread's pages so a restart can rebuild them.
   *
   * Names are kept because the agent addresses pages by name, and a restore
   * that gave back the right URLs under different names would be a thread whose
   * own instructions no longer resolved. The active index is kept because "the
   * page I was working on" is part of the state, not a detail.
   *
   * `about:blank` pages are skipped: they carry nothing, and restoring them
   * would fill the tab strip with blanks that mean nothing to either side.
   */
  private async savePages(statePath: string): Promise<void> {
    const entries = await this.pageEntries();
    /*
     * Scroll and title are captured per page, and scroll is the one that earns
     * its round trip.
     *
     * It was left out at first on the theory that a restored URL is the whole of
     * the state worth keeping. It is not: a thread that was part-way down a
     * 40-result job listing came back at the top and the agent re-read the same
     * twenty rows it had already dismissed, which is both a waste and a reason
     * to make the same decision twice. It is one `evaluate` per page, and only
     * on a save.
     */
    const pages: Array<{ url: string; name: string | undefined; title: string; scrollX: number; scrollY: number }> = [];
    const owned: string[] = [];
    for (const entry of entries) {
      /*
       * Ownership is recorded for every page, including a blank one.
       *
       * The URL filter below skips `about:blank` because reopening one is
       * meaningless, but ownership is about *which thread may touch this tab*, and
       * a blank tab the agent opened is still the agent's. Recording it only for
       * pages with a URL would lose a freshly opened tab across a restart and
       * leave it unowned, so a later attach would either leak it or refuse it.
       */
      const id = (entry.page as unknown as { pageTargetId?: unknown }).pageTargetId;
      if (typeof id === "string" && id.length > 0) owned.push(id);
      const url = entry.page.url();
      if (!url || url === "about:blank") continue;
      const title = await entry.page.title().catch(() => "");
      const scroll = (await entry.page
        .evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
        .catch(() => ({ x: 0, y: 0 }))) as { x: number; y: number };
      pages.push({ url, name: entry.name, title, scrollX: scroll.x, scrollY: scroll.y });
    }
    /*
     * Ownership is NOT written here any more.
     *
     * `persistOwnership` writes it, with names, on every claim, which is both
     * sooner (a crash does not lose a page opened this step) and the only writer:
     * two paths writing the same file could interleave a read-modify-write and
     * lose an entry. What stays here is the page list, which is the part that
     * needs a settled page and so can only be written at the end of a step.
     */
    if (pages.length === 0) return;
    const activeIndex = Math.max(0, entries.findIndex((entry) => entry.active));
    const payload = JSON.stringify({ version: 1, pages, activeIndex });
    const target = ThreadBrowserRuntime.pagesPath(statePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, target);
  }

  /**
   * Rebuild the thread's pages in a freshly attached context.
   *
   * The first saved page reuses the blank page `newContext` already made, so a
   * single-page thread restores without a stray extra tab. The rest are created
   * in order, because order is what `browser.setActive(1)` and the viewer's tab
   * strip both mean.
   *
   * Every navigation is best-effort: a site that is down, or a URL that
   * requires a login the cookies no longer cover, must not stop the thread from
   * attaching. The page is still there, at whatever the browser landed on, and
   * the agent can see that and act.
   */
  private async restorePages(context: BrowserContext): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    let saved:
      | {
          pages?: Array<{ url?: string; name?: string; scrollX?: number; scrollY?: number }>;
          activeIndex?: number;
        }
      | undefined;
    try {
      saved = JSON.parse(await readFile(ThreadBrowserRuntime.pagesPath(path), "utf8"));
    } catch {
      return;
    }
    const pages = (saved?.pages ?? []).filter((entry) => typeof entry?.url === "string" && entry.url.length > 0);
    if (pages.length === 0) return;

    /*
     * A page that is ALREADY open is adopted, never re-navigated.
     *
     * This is the difference between restoring a workspace and destroying it.
     * The loop below used to navigate every saved URL, which is right when the
     * browser has been restarted and wrong in the case that matters most: a
     * reconnect to a browser whose pages are still live. Navigating them reloads
     * each document, so every typed form value, every piece of JavaScript state
     * and every partially completed checkout is thrown away at exactly the moment
     * the design promises to keep them. Measured: a token stamped on `window` was
     * gone after a reconnect, while the page URL was correct, which is what a
     * reload looks like.
     *
     * The live pages are matched to the saved entries by URL, and only the entries
     * with no live match are rebuilt.
     */
    const liveByUrl = new Map<string, Page>();
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      const url = candidate.url();
      if (url && url !== "about:blank") liveByUrl.set(url, candidate);
    }

    const restored: Page[] = [];
    const usedLive = new Set<Page>();
    for (const [index, entry] of pages.entries()) {
      try {
        const live = liveByUrl.get(entry.url!);
        if (live !== undefined && !usedLive.has(live)) {
          /*
           * Already open and already carrying this URL: adopt it as it stands.
           * The scroll is left alone too, because the live page is where the user
           * or the agent left it and scrolling it back would be a small version
           * of the same mistake.
           */
          usedLive.add(live);
          restored.push(live);
          if (typeof entry.name === "string" && entry.name.length > 0) {
            this.named.set(entry.name, { name: entry.name, page: live, openedAt: Date.now() });
          }
          continue;
        }
        const page = index === 0 && usedLive.size === 0
          ? (context.pages().find((p) => !p.isClosed() && !usedLive.has(p)) ?? (await context.newPage()))
          : await context.newPage();
        await page.goto(entry.url!, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        /*
         * Put the page back where it was. Best-effort and after the load, since
         * a scroll before the document exists does nothing, and a page that
         * refuses the evaluation is still a page worth having.
         */
        if (typeof entry.scrollY === "number" || typeof entry.scrollX === "number") {
          const x = typeof entry.scrollX === "number" ? entry.scrollX : 0;
          const y = typeof entry.scrollY === "number" ? entry.scrollY : 0;
          if (x !== 0 || y !== 0) {
            await page.evaluate(`window.scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)})`).catch(() => undefined);
          }
        }
        await this.claimOwn(page);
        restored.push(page);
        if (typeof entry.name === "string" && entry.name.length > 0) {
          this.named.set(entry.name, { name: entry.name, page, openedAt: Date.now() });
        }
      } catch {
        // One page that cannot be rebuilt must not cost the others.
      }
    }
    if (restored.length === 0) return;
    const activeIndex = Math.min(Math.max(saved?.activeIndex ?? 0, 0), restored.length - 1);
    this.active = restored[activeIndex];
    this.activeTargetId = await targetIdOf(restored[activeIndex]!).catch(() => undefined);
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
    /*
     * Marked first, so an attach still in flight tears its connection down
     * instead of storing it. See the field's comment: without this the
     * connection lands after shutdown and keeps the process alive.
     */
    this.closed = true;
    const context = this.context;
    const browser = this.browser;
    /*
     * Persist before anything is torn down, and this is the fix for a real bug
     * rather than a tidy-up.
     *
     * `save()` existed and was only reachable if the *model* called it. Nothing
     * called it on the way out, so the state file was never written at all:
     * every thread started from a clean context, and every login, cookie and
     * local-storage value was gone the moment the idle reaper closed the
     * browser. Reproduced: set a cookie, close the runtime the way the reaper
     * does, reattach, and the cookie is absent and no state file exists.
     *
     * Here rather than in `close()`'s caller because this is the one place that
     * has both the live context and the knowledge that it is about to be
     * destroyed. `resetHandles` below clears `this.context`, so this must run
     * first.
     */
    if (context) await this.save().catch(() => undefined);

    /*
     * This thread's pages, closed by target id.
     *
     * `context.close()` was the wrong call once the context became the browser's
     * shared default one: it would close every thread's pages, and the `.catch`
     * that swallowed the failure hid that. Measured on the mission: pages were
     * never released, twenty-six of them accumulated across runs, and
     * `connectOverCDP` eventually could not finish its handshake at all because
     * every attach enumerates every target. A browser that cannot be attached to
     * is the failure this whole design exists to prevent.
     *
     * Closed individually and before the handles are cleared, because the target
     * id is what identifies a page and `resetHandles` is what forgets it.
     */
    await this.closeOwnedPages().catch(() => undefined);

    this.resetHandles();

    /*
     * `browser.close()` on a CDP connection detaches *this* connection. It does
     * not stop Steel's Chrome: Steel owns the process, and the browser
     * outliving a thread is what makes a login survive one. Detaching is what
     * this must do, and it must actually happen, which is the bug above.
     */
    if (browser) await browser.close().catch(() => undefined);
  }

  /**
   * Close every page this thread owns, by target id.
   *
   * A target id survives a reconnect and a restart, so this works from the
   * thread's own record even when no runtime is live: which is exactly the case
   * that leaked, since a deleted thread whose server had restarted had no
   * runtime to close anything.
   *
   * Best-effort per page. One page that refuses to close must not stop the
   * others from being released, because the cost of a stubborn page is a slow
   * attach for every thread and the cost of abandoning the rest is the same
   * problem this fixes.
   */
  private async closeOwnedPages(): Promise<void> {
    const context = this.context;
    if (!context) return;
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const id = (page as unknown as { pageTargetId?: unknown }).pageTargetId;
      const resolved = typeof id === "string" && id.length > 0 ? id : await targetIdOf(page).catch(() => undefined);
      /*
       * Only pages this thread owns are closed. A page with no owner is somebody
       * else's, or one the browser opened for itself, and closing it from here
       * would reach outside this thread.
       */
      if (resolved === undefined || !isPageOwnedBy(resolved, this.threadId)) continue;
      await page.close().catch(() => undefined);
    }
  }
}

/**
 * The stats a perception produced, in the shape the observer reports.
 *
 * The compiled view has no `[ref=]` markers for `countOutline` to find, so the
 * compiler's own counts are passed instead. `interactive` is the one field that
 * cannot be answered from the compile directly: an element carrying a locator is
 * one the model can act on, which is what the field means.
 */
/** "1st", "2nd", "3rd", "4th". */
function ordinalSuffix(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return "th";
  switch (value % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function statsOf(perceived: PerceptionResult): SnapshotStats {
  /*
   * Counted from the text, because that is what the stub produces and the text
   * is Playwright's own snapshot: it marks every addressable element with
   * `[ref=...]`, so the counts are real, and `countOutline` finds them the same
   * way it always did.
   *
   * This was reading `perceived.ir.elements.size` while the compiler existed,
   * because a compiled view has no ref markers to count. When the compiler
   * returns it will need the branch back; until then the text is the only source
   * and it is an accurate one.
   */
  const text = perceived.text;
  const counted = countOutline(text, false);
  return {
    lines: text.split("\n").filter((line) => line.trim().length > 0).length,
    chars: text.length,
    refs: counted.refs,
    interactive: counted.interactive,
  };
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
/**
 * Record a page's target id on the page itself.
 *
 * The id has to live on the object, because the runtime sometimes receives a
 * page back *through* the sandbox and cannot ask the browser about it: a scoped
 * page refuses `newCDPSession`, which is the guard working as designed. A
 * property survives that round trip, because the scoping proxy forwards reads it
 * does not itself handle.
 *
 * Non-enumerable and best-effort, so a frozen or exotic page is not an error
 * here and a serialized page does not gain a field.
 */
function recordTargetId(page: Page, targetId: string | undefined): void {
  if (targetId === undefined) return;
  try {
    Object.defineProperty(page, "pageTargetId", { value: targetId, enumerable: false, configurable: true });
  } catch {
    /* A page that refuses the property simply has no recorded id. */
  }
}

async function targetIdOf(page: Page): Promise<string | undefined> {
  /*
   * A recorded id is used when there is one, before asking the browser.
   *
   * `describePages` attaches the target id to each page it hands out, and that
   * matters because a page which came back *through* the sandbox is a proxy
   * whose `context()` is scoped: `newCDPSession` on it is refused, which is the
   * guard working as designed and which would make this function fail for the
   * one caller that legitimately has such a page. Reading the recorded id avoids
   * needing an unguarded handle at all, and it is not a secret: the id is what
   * the live-view tab list already publishes.
   */
  const recorded = (page as unknown as { pageTargetId?: unknown }).pageTargetId;
  if (typeof recorded === "string" && recorded.length > 0) return recorded;
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
