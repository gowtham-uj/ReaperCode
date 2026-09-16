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

import { BrowserControlRegistry } from "../browser/control-lease.js";
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
}

const DEFAULT_IDLE_MS = 10 * 60_000;

export class ThreadBrowsers {
  private readonly runtimes = new Map<string, ThreadBrowserRuntime>();
  /** When each thread's browser was last used, for the idle reaper. */
  private readonly lastUsed = new Map<string, number>();
  private reaper: NodeJS.Timeout | undefined;
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
    const runtime = new ThreadBrowserRuntime({
      threadId,
      cdpUrl: this.options.cdpUrl,
      ...(this.options.statePathFor ? { statePath: this.options.statePathFor(threadId) } : {}),
      ...(this.options.flows ? { flows: this.options.flows } : {}),
      // One registry for the whole server, so the HTTP handler that takes
      // control and the browser tool that must respect it read one record.
      control: this.control,
    });
    this.runtimes.set(threadId, runtime);
    this.lastUsed.set(threadId, Date.now());
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
    await runtime?.close().catch(() => undefined);
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
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    this.lastUsed.clear();
    await Promise.all(all.map((runtime) => runtime.close().catch(() => undefined)));
  }
}
