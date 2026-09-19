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
import { connectWithRecovery } from "../browser/cdp-health.js";
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
  /**
   * Whether a thread has a turn in flight.
   *
   * The reaper's last line of defence, and the reason it exists is that the
   * activity clock cannot see everything. A model can think for longer than the
   * idle window between two browser calls, and during that gap the clock is
   * honest: the browser really was untouched. But the thread is not idle in any
   * sense a user would recognise, and retiring it would still close the tabs of
   * a turn that is going to ask for them next.
   *
   * Supplied by the app-server, which owns the answer. Absent means "nothing is
   * running", which is the right default for a test that has no turns.
   */
  threadIsRunning?: ((threadId: string) => boolean) | undefined;
  /**
   * The ids of the threads that currently exist.
   *
   * The orphan sweep needs this to tell an ownership file that is a real claim
   * from one a deleted thread left behind. Without it the sweep does not run:
   * treating every file as a claim is the bug this exists to fix, and the sweep
   * is the only thing that closes pages, so an unanswerable question stops it
   * rather than making it guess.
   *
   * A function rather than a list because the browser owner is built before the
   * thread manager and threads come and go after that.
   */
  liveThreadIds?: (() => Promise<ReadonlySet<string>>) | undefined;
  /**
   * Where a thread's files live, which is also its sandbox root.
   *
   * The download vault goes inside it, because a downloaded file has to be
   * readable by the model to be uploaded somewhere else, and the workspace is the
   * only directory the sandbox mounts. Synchronous deliberately: it is called
   * from a constructor, and the manager holds the record already.
   */
  workspaceFor?: ((threadId: string) => string | undefined) | undefined;
}

const DEFAULT_IDLE_MS = 10 * 60_000;

/** How often pages nobody owns are closed. See `sweepOrphans`. */
const ORPHAN_SWEEP_MS = 5 * 60_000;

export class ThreadBrowsers {
  private readonly runtimes = new Map<string, ThreadBrowserRuntime>();
  /*
   * There is deliberately no `lastUsed` map here any more.
   *
   * There was one, it was written by `forThread`, and the reaper read it. That
   * indirection was the bug: the map records lookups, and the browser tool does
   * not look a thread up per step, so it under-reported activity badly enough to
   * retire a browser out from under a running turn. Idleness now comes from the
   * runtime's own clock (`idleForMs`), which is stamped by use rather than by
   * lookup. A map that is written and never read is worse than no map, so the
   * dead field is gone rather than left for the next reader to trust.
   */
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
    if (existing) return existing;
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
    return runtime;
  }

  /** Construct one thread's runtime. Split out so `forThread` stays readable. */
  private buildRuntime(threadId: string): ThreadBrowserRuntime {
    /*
     * The workspace is resolved synchronously from an already-loaded record.
     *
     * Needed here rather than later because the download vault lives inside it:
     * a file the runtime keeps has to be readable by the model, and the workspace
     * is the only directory both can see. `workspaceFor` answers from the thread
     * map the manager already holds, so this stays a plain constructor.
     */
    const workspace = this.options.workspaceFor?.(threadId);
    const runtime = new ThreadBrowserRuntime({
      threadId,
      cdpUrl: this.options.cdpUrl,
      ...(this.options.statePathFor ? { statePath: this.options.statePathFor(threadId) } : {}),
      ...(workspace !== undefined ? { workspaceRoot: workspace } : {}),
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
   * It attaches to the browser to do this, so it goes through recovery rather
   * than a bare connect. That is what stops a failure worth naming: a page whose
   * renderer stopped answering makes `connectOverCDP` hang until it times out,
   * which meant this pass could never run on the one browser that needed it, so
   * a browser in that state stayed unattachable until it was restarted by hand.
   *
   * The sweep runs only after a failed connect, so a healthy browser is never
   * touched by it. Sweeping first closed a page a live mission was using under
   * load, which is why the order is the way it is.
   */
  async sweepOrphans(): Promise<OrphanSweepResult | undefined> {
    if (this.closed) return undefined;
    /*
     * Only the threads that still exist own anything.
     *
     * An ownership file left by a deleted thread used to count as a claim, so
     * its pages were never closed and the browser accumulated them until an
     * attach was slow enough to look like a hang. Measured: a `drop-test` file
     * outlived its thread record and made every page it named permanently immune
     * to this sweep.
     *
     * With no provider, nothing is live and nothing is owned, which stops the
     * sweep rather than letting it act on stale files. That is the safe
     * direction: this pass is the only thing that closes pages, and closing one
     * a live thread is using is worse than leaving one behind. A caller that
     * wants the sweep to run supplies the ids.
     */
    const live = this.options.liveThreadIds;
    if (!live) return undefined;
    const liveIds = await live().catch(() => undefined);
    if (liveIds === undefined) return undefined;
    const owned = await readOwnedTargetIds(this.workspaceRoot, liveIds).catch(() => undefined);
    if (owned === undefined) return undefined;
    /*
     * Only attach when there are ownership records to check against. A workspace
     * with none has nothing to compare, and `sweepOrphanPages` refuses to act in
     * that state anyway, so paying for an attach to learn that would be waste.
     */
    if (owned.size === 0) return undefined;

    let browser;
    try {
      browser = await connectWithRecovery(this.options.cdpUrl, { timeoutMs: this.options.sweepAttachTimeoutMs ?? 45_000 });
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
    /*
     * Idleness is measured by the runtime, not by the lookup map.
     *
     * `lastUsed` records `forThread` calls, and a turn does not make one per
     * step: the browser tool holds its runtime for the whole turn. So the map
     * said "idle for ten minutes" about a thread whose browser had been driven a
     * second earlier. The reaper then retired that runtime out from under the
     * running turn, which is how a mission lost all twelve of its pages and every
     * later call reported the browser as unattachable. The runtime's own activity
     * clock is the honest answer, and it makes a turn that is browsing
     * un-reapable rather than lucky.
     */
    for (const [threadId, runtime] of this.runtimes) {
      if (runtime.idleForMs() < idleMs) continue;
      /*
       * A thread with a turn in flight is never reaped, however long its browser
       * has sat untouched. `idleForMs` answers "when was this browser last
       * driven", which is the right question for a thread whose agent is done,
       * and the wrong one for a thread whose agent is thinking: a model can
       * reason for longer than the idle window and then ask for the tabs it left
       * open. Checked after the clock so the common case costs one number.
       */
      if (this.options.threadIsRunning?.(threadId) === true) continue;
      this.runtimes.delete(threadId);
      /*
       * Retired, not closed. A turn may still be holding this object, and
       * retiring leaves it able to attach again; closing would poison it
       * permanently. See `retire` for the measured failure.
       *
       * A failure here is a browser that is already gone, which is the state
       * this was trying to reach.
       */
      await runtime.retire().catch(() => undefined);
    }
  }

  /**
   * Close one thread's browser because the thread is gone.
   *
   * Only this connection and this context: the Chrome process is Steel's and
   * other threads are still using it.
   */
  async closeThread(threadId: string): Promise<void> {
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

    /*
     * Through recovery, for the same reason the orphan sweep is: this is a
     * delete, and a delete that hangs because some page stopped answering is a
     * thread the user cannot remove. Recovery closes any wedged page and not only
     * this thread's, which is correct rather than overreaching: a page whose
     * renderer is gone cannot be used by any thread, and leaving it would block
     * every delete and every attach from here on. It runs only after a failed
     * connect, so a busy but healthy browser is never touched.
     */
    const browser = await connectWithRecovery(this.options.cdpUrl, { timeoutMs: 45_000 });
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
    await Promise.all(all.map((runtime) => runtime.close().catch(() => undefined)));
  }
}
