/**
 * One browser per thread, owned by the app-server.
 *
 * The lifetime rule is the whole design, and it follows from what Steel is. A
 * Steel session is one Chrome; our `BrowserContext` inside it is the isolation
 * unit; and a page and its cookies live only as long as the Playwright
 * connection that created them. So a runtime has to outlive a single turn or a
 * login would not survive from one message to the next, which is the entire
 * reason the browser is attached rather than launched per call.
 *
 * This is deliberately the only place a `ThreadBrowserRuntime` is created. One
 * owner means one connection per thread, so the "attach twice and orphan a
 * context" failure cannot happen by accident.
 *
 * Nothing here calls Steel's REST API. Releasing a session there runs
 * `browserInstance.close()` and `process().kill()`, which destroys Chrome for
 * every thread attached to it, so release belongs to whoever started Steel and
 * to nothing else. A thread that wants to start over closes its own context.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { BrowserControlRegistry } from "../browser/control-lease.js";
import { resetUnresponsiveTargets } from "../browser/cdp-health.js";
import { forgetPage } from "../browser/page-ownership.js";
import { readOwnedTargetIds, sweepOrphanPages, type OrphanSweepResult } from "../browser/orphan-reaper.js";
import { ThreadBrowserRuntime } from "../browser/thread-runtime.js";
import type { TransitionDb } from "../browser/transition-db.js";

export interface ThreadBrowsersOptions {
  /** CDP endpoint of the browser to attach to. */
  cdpUrl: string;
  /** Close an idle thread's browser after this long. */
  idleMs?: number;
  /**
   * Where a thread's cookies are persisted.
   *
   * A function of the thread id rather than a fixed path, because each thread
   * gets its own file: sharing one would mean a login in one chat appearing in
   * another, which is exactly the isolation the per-thread context exists for.
   *
   * Absent means in-memory only, which is what a test wants.
   */
  statePathFor?: ((threadId: string) => string) | undefined;
  /**
   * The learned site graph.
   *
   * One for the server, not one per thread: a site's shape is the same for
   * everybody, and the value of the graph comes from accumulating across
   * threads. What is per-thread stays per-thread, and that is the browser state
   * (`statePathFor`) rather than the recipe.
   */
  flows?: TransitionDb | undefined;
  /**
   * The workspace root the ownership records live under.
   *
   * Passed in rather than derived so a caller that moves its `.reaper` root has
   * one place to say so. Defaults to the directory the state files imply, which
   * is what every caller already means.
   */
  workspaceRoot?: string;
  /** How long the orphan sweep waits to attach. Overridable for a test. */
  sweepAttachTimeoutMs?: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;

/** How often pages nobody owns are closed. See `sweepOrphans`. */
const ORPHAN_SWEEP_MS = 5 * 60_000;

export class ThreadBrowsers {
  private readonly runtimes = new Map<string, ThreadBrowserRuntime>();
  /** When each thread's browser was last used, for the idle reaper. */
  private readonly lastUsed = new Map<string, number>();
  private reaper: NodeJS.Timeout | undefined;
  /** Set by `close()`. See `forThread` for why a late request must not attach. */
  private closed = false;
  /** The orphan sweep's timer. See `start`. */
  private sweeper: NodeJS.Timeout | undefined;
  /**
   * Who may drive each thread's browser.
   *
   * Held here, not in each runtime, because the gateway's control endpoint
   * looks a thread up by id and the browser tool holds a runtime: one registry
   * on the server is what makes those two the same answer. Created here rather
   * than injected because there is nothing to configure about it.
   */
  readonly control = new BrowserControlRegistry();

  constructor(private readonly options: ThreadBrowsersOptions) {}

  /**
   * The endpoint every thread's browser attaches to.
   *
   * Read by the gateway so the preview proxy can refuse to forward to it: it is
   * one of Reaper's own services, so it is not a dev server and must not be
   * reachable through a preview. Exposed rather than threaded through the
   * options again so the endpoint the proxy reserves is provably the endpoint
   * the browser uses, which is the property that would otherwise drift.
   */
  get cdpUrl(): string {
    return this.options.cdpUrl;
  }

  /**
   * The workspace root the ownership records live under.
   *
   * Derived from where a thread's state file goes, rather than a second setting
   * that could disagree with it: the records are written beside the state files,
   * so the directory that holds one holds the other.
   */
  private get workspaceRoot(): string {
    if (this.options.workspaceRoot !== undefined) return this.options.workspaceRoot;
    const sample = this.options.statePathFor?.("probe");
    if (sample === undefined) return process.cwd();
    // `<root>/.reaper/browser/probe.json` -> `<root>`
    return dirname(dirname(dirname(sample)));
  }

  /**
   * The runtime for a thread, attaching on first use.
   *
   * `ensureReady` is not awaited here. Attaching takes a CDP round trip, and
   * blocking every turn on it would pay that cost even for turns that never
   * touch the browser. The tool awaits it when it needs the page, which is the
   * moment the cost is unavoidable and worth paying.
   */
  forThread(threadId: string): ThreadBrowserRuntime {
    const existing = this.runtimes.get(threadId);
    if (existing) {
      this.lastUsed.set(threadId, Date.now());
      return existing;
    }
    /*
     * After shutdown, a request that arrives late gets a runtime that will not
     * attach.
     *
     * The gateway closes concurrently with this, so a live-view poll that was
     * already in flight can call `forThread` after `close()` has cleared the
     * map. Constructing a fresh runtime there is how a browser connection lands
     * *after* shutdown and outlives the server: the new runtime is not in the
     * map `close()` iterated, so nothing ever closes it. Measured as sockets to
     * Steel still ESTABLISHED after `stop()` returned, with the process hanging
     * on them.
     *
     * The runtime is still returned, because callers hold it and deserve a
     * typed failure rather than a crash, but it is already closed so its first
     * attach tears itself down instead of connecting.
     */
    const runtime = this.buildRuntime(threadId);
    if (this.closed) runtime.close().catch(() => undefined);
    this.runtimes.set(threadId, runtime);
    this.lastUsed.set(threadId, Date.now());
    return runtime;
  }

  /** Construct one thread's runtime. Split out so `forThread` stays readable. */
  private buildRuntime(threadId: string): ThreadBrowserRuntime {
    const runtime = new ThreadBrowserRuntime({
      threadId,
      cdpUrl: this.options.cdpUrl,
      ...(this.options.statePathFor ? { statePath: this.options.statePathFor(threadId) } : {}),
      ...(this.options.flows ? { flows: this.options.flows } : {}),
      // One registry for the whole server, so the HTTP handler that takes
      // control and the browser tool that must respect it read one record.
      control: this.control,
    });
    return runtime;
  }

  /**
   * The runtime for a thread if one already exists, without creating one.
   *
   * Distinct from `forThread` on purpose, and the distinction is load-bearing
   * for the live browser pane. That pane asks "is this thread driving a browser
   * I can show", and `forThread` would answer yes to everything: it constructs a
   * runtime on demand, so a pane opened for a thread that has never touched the
   * browser would create one and then wait for a page that will never come.
   * `peek` answers the question actually asked, and returns undefined for a
   * thread with no browser, which the pane reports as "waiting for the agent".
   */
  peek(threadId: string): ThreadBrowserRuntime | undefined {
    return this.runtimes.get(threadId);
  }

  /** Start the idle reaper. Called once, by the app-server, at boot. */
  start(): void {
    if (this.reaper) return;
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    /*
     * Unref'd, so a process with nothing else to do exits rather than sitting
     * alive for a timer that only closes browsers nobody is using.
     */
    this.reaper = setInterval(() => {
      void this.reap(idleMs);
    }, Math.max(60_000, Math.floor(idleMs / 4)));
    this.reaper.unref?.();

    /*
     * The orphan sweep, on its own slower timer.
     *
     * Separate from the idle reaper because it answers a different question:
     * that one closes browsers nobody is *using*, this one closes pages nobody
     * *owns*. A page can be owned by a thread that has been idle for an hour and
     * must not be touched; a page can be an orphan one second after its thread
     * is deleted. Coupling them would mean either closing live work or leaving
     * orphans for up to the idle interval.
     *
     * Five minutes, and it does not attach unless there is something to check:
     * the cost when there are no orphans is a directory read.
     */
    this.sweeper = setInterval(() => {
      void this.sweepOrphans();
    }, ORPHAN_SWEEP_MS);
    this.sweeper.unref?.();
  }

  /**
   * Close pages no thread owns.
   *
   * Runs on a timer so the browser cannot quietly fill up between restarts, and
   * is called directly after a thread is deleted so the common case is immediate
   * rather than eventually.
   *
   * It attaches to the browser to do this, so it clears wedged pages first. That
   * ordering is the fix for a failure worth naming: `connectOverCDP` waits on
   * every target, so a page whose renderer stopped answering made the attach
   * hang until it timed out, which meant this pass could never run on the one
   * browser that needed it, and a browser in that state stayed unattachable
   * until it was restarted by hand. Sweeping health before attaching removes
   * that deadlock: the sweep talks raw CDP, so it works exactly when the
   * Playwright attach does not.
   */
  async sweepOrphans(): Promise<OrphanSweepResult | undefined> {
    if (this.closed) return undefined;
    // Before anything attaches: a wedged page would hang the attach below.
    await resetUnresponsiveTargets(this.options.cdpUrl).catch(() => undefined);
    const owned = await readOwnedTargetIds(this.workspaceRoot).catch(() => undefined);
    if (owned === undefined) return undefined;
    /*
     * Only attach when there are ownership records to check against. A workspace
     * with none has nothing to compare, and `sweepOrphanPages` refuses to act in
     * that state anyway, so paying for an attach to learn that would be waste.
     */
    if (owned.size === 0) return undefined;

    const { chromium } = await import("playwright");
    let browser;
    try {
      browser = await chromium.connectOverCDP(this.options.cdpUrl, { timeout: this.options.sweepAttachTimeoutMs ?? 30_000 });
    } catch (error) {
      /*
       * A browser that cannot be attached to is the failure this pass exists to
       * prevent, and by the time it happens there is nothing to do but report
       * it: nothing here can attach, so nothing here can clean up.
       */
      return {
        examined: 0,
        closed: 0,
        kept: 0,
        closedIds: [],
        errors: [`could not attach to sweep orphan pages: ${(error as Error).message}`],
      };
    }
    try {
      const result = await sweepOrphanPages(browser, owned);
      for (const id of result.closedIds) forgetPage(id);
      return result;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /** Close the browsers of threads that have not been used for a while. */
  private async reap(idleMs: number): Promise<void> {
    const cutoff = Date.now() - idleMs;
    for (const [threadId, usedAt] of this.lastUsed) {
      if (usedAt > cutoff) continue;
      this.lastUsed.delete(threadId);
      const runtime = this.runtimes.get(threadId);
      this.runtimes.delete(threadId);
      // A failure here is a browser that is already gone, which is the state
      // this was trying to reach.
      await runtime?.close().catch(() => undefined);
    }
  }

  /**
   * Close one thread's browser because the thread is gone.
   *
   * Only this connection and this context: the Chrome process is Steel's and
   * other threads are still using it.
   */
  async closeThread(threadId: string): Promise<void> {
    this.lastUsed.delete(threadId);
    const runtime = this.runtimes.get(threadId);
    this.runtimes.delete(threadId);
    if (runtime !== undefined) {
      await runtime.close().catch(() => undefined);
      return;
    }
    /*
     * No runtime: this thread is being deleted after a restart, and its pages
     * are still open in the browser.
     *
     * This is the case that leaked. `close()` on a runtime closes that runtime's
     * pages, but a restarted server has no runtime for a thread it has not
     * resumed, so nothing closed anything and the pages stayed. Measured: the
     * mission's runs left twenty-six pages open, and `connectOverCDP` stopped
     * being able to complete its handshake, because every attach enumerates
     * every target in the browser.
     *
     * The ownership record on disk names the pages, and a target id is what the
     * browser answers to, so the pages can be closed without a runtime at all.
     */
    await this.closeRecordedPages(threadId).catch(() => undefined);
  }

  /**
   * Close the pages a thread's own record names, with no runtime involved.
   *
   * Best-effort by design: a delete must not fail because the browser is down,
   * and the next delete or the next reaper pass will try again. What it must not
   * do is leave the pages, which is what it did before.
   */
  private async closeRecordedPages(threadId: string): Promise<void> {
    const path = this.options.statePathFor?.(threadId);
    if (path === undefined) return;
    let targetIds: string[] = [];
    try {
      const raw = await readFile(`${path}.pages-owner.json`, "utf8");
      const parsed = JSON.parse(raw) as { targetIds?: unknown };
      if (Array.isArray(parsed.targetIds)) targetIds = parsed.targetIds.filter((id): id is string => typeof id === "string");
    } catch {
      return;
    }
    if (targetIds.length === 0) return;

    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(this.options.cdpUrl, { timeout: 30_000 });
    try {
      const context = browser.contexts()[0];
      if (context === undefined) return;
      const wanted = new Set(targetIds);
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        /*
         * The id is asked for rather than trusted from the page object, because
         * these pages were opened by a process that is gone and carry no stamp.
         */
        const session = await context.newCDPSession(page).catch(() => undefined);
        if (session === undefined) continue;
        const info = await session.send("Target.getTargetInfo").catch(() => undefined);
        await session.detach().catch(() => undefined);
        const id = (info as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo?.targetId;
        if (id !== undefined && wanted.has(id)) {
          await page.close().catch(() => undefined);
          /*
           * Ownership is released with the page. A closed tab that keeps its
           * owner would make the next page to reuse that id answer to a thread
           * that has been deleted.
           */
          forgetPage(id);
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /** How many threads currently hold a browser, for status and tests. */
  get size(): number {
    return this.runtimes.size;
  }

  /**
   * Close every thread's browser.
   *
   * Detaching only. The browser process outlives this: Steel owns it, and a
   * shutdown that killed Chrome would be a decision about Steel's lifecycle
   * made by the wrong component.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    this.lastUsed.clear();
    await Promise.all(all.map((runtime) => runtime.close().catch(() => undefined)));
  }
}
