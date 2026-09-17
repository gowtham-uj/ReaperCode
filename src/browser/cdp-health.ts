/**
 * Keeping one unresponsive page from making the whole browser unattachable.
 *
 * This exists because of a failure that took out three mission runs in a row,
 * and the mechanism is worth writing down precisely, because the symptom points
 * somewhere else entirely.
 *
 * Playwright's `connectOverCDP` attaches to *every* target the browser reports
 * and waits for each one to answer. When a single page's renderer stops
 * answering, that wait never finishes, and the connect times out. Measured on a
 * live session with one such page:
 *
 *   connectOverCDP against Steel            120000ms, timed out, three times
 *   raw CDP socket, Target.getTargets          113ms, 17 targets
 *   attach + Runtime.evaluate on 12 targets    <150ms each
 *   attach + Runtime.evaluate on the one page  6000ms, no answer
 *   connectOverCDP after closing that page     11095ms, succeeded
 *
 * So the browser was never broken. Steel was serving, Chrome was running, twelve
 * pages were live and interactive, and the live pane showed all of them. One tab
 * (an http site that had been left mid-navigation) had a wedged renderer, and
 * that one tab made every future attach impossible. The agent, seeing only
 * "the browser could not be attached" against a browser it could see working in
 * the pane, reasonably concluded the browser had crashed and stopped.
 *
 * Playwright offers no way to skip a target or to attach partially, and Steel
 * has no page-level API, so the only place to fix this is before the handshake:
 * find the targets whose renderers have stopped answering, close those, and let
 * the connect proceed. A page that cannot execute `1+1` in this budget is a page
 * no thread can use, so closing it loses nothing.
 *
 * This talks CDP directly rather than through Playwright, and that is the whole
 * point: it has to run when `connectOverCDP` cannot.
 */

/** A target whose renderer did not answer inside the probe budget. */
export interface HungTarget {
  targetId: string;
  url: string;
  type: string;
}

export interface HealthReport {
  /** Page and iframe targets that were probed. */
  checked: number;
  /** Targets whose renderer failed to answer. */
  hung: HungTarget[];
  /** Targets that were closed as a result. */
  closed: HungTarget[];
  elapsedMs: number;
  /** Set when the sweep could not run, with the reason. */
  skipped?: string;
}

export interface HealthOptions {
  /**
   * How long a target's renderer has to answer `1+1` in one attempt.
   *
   * Deliberately long. A healthy renderer answers in single-digit milliseconds
   * when the browser is idle, but this runs against a browser that is busy: a
   * session mid-mission has pages running scripts, and Steel's CDP proxy is a
   * single serialising hop. Measured while a mission was driving eleven pages,
   * a burst of parallel probes pushed several healthy pages past a 2.5s budget,
   * and they were reported wedged. A wedged renderer is not slow, it is silent:
   * it never answers however long you wait, so the timeout can be generous
   * without weakening the test at all.
   */
  probeTimeoutMs?: number;
  /**
   * How many consecutive failures make a target wedged.
   *
   * The load-bearing safety property. A true wedge fails every attempt, so
   * requiring several costs nothing in detection and removes the transient
   * overload false positive entirely: a page that was merely busy answers on a
   * later attempt and is left alone. Closing a page a thread is using is a far
   * worse outcome than missing a wedge on one pass, because the next pass will
   * catch a real wedge anyway.
   */
  attempts?: number;
  /** How many targets are probed at once, to avoid overloading the proxy. */
  concurrency?: number;
  /** Ceiling on the whole sweep, including the socket and the target list. */
  budgetMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 45_000;

/**
 * The expression used to decide whether a renderer is alive.
 *
 * A literal `1+1` with `returnByValue`, because the answer is not the point: the
 * point is that the renderer's main thread ran something at all. Anything with a
 * side effect, or anything that reads the page, would make the probe itself a
 * thing that can hang on a busy page.
 */
const LIVENESS_EXPRESSION = "1+1";

/** A minimal CDP client over the global WebSocket, used only when Playwright cannot connect. */
class CdpSocket {
  private constructor(private readonly socket: WebSocket) {}

  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();

  static async open(url: string, timeoutMs: number): Promise<CdpSocket> {
    const socket = new WebSocket(url);
    const self = new CdpSocket(socket);
    socket.addEventListener("message", (event: MessageEvent) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const resolve = self.pending.get(message.id);
      if (!resolve) return;
      self.pending.delete(message.id);
      resolve(message.error ? { error: message.error.message ?? "CDP error" } : { result: message.result });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no CDP socket within ${timeoutMs}ms`)), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the CDP socket refused the connection"));
      });
    });
    return self;
  }

  /**
   * Send one command and wait for its reply, or for the timeout.
   *
   * Never rejects. A command that times out resolves with an `error` string,
   * because the caller's whole reason for being here is that commands can stop
   * answering, and a rejected promise would turn that expected case into an
   * exception at every call site.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  ): Promise<{ result?: unknown; error?: string; elapsedMs: number }> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const started = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: "timeout", elapsedMs: Date.now() - started });
      }, timeoutMs);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve({ ...(value as { result?: unknown; error?: string }), elapsedMs: Date.now() - started });
      });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId !== undefined) message["sessionId"] = sessionId;
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // A socket that is already gone is the state this was trying to reach.
    }
  }
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/**
 * One liveness attempt against a target: did its renderer answer?
 *
 * Returns `true` only on a real answer. An attach that failed is reported as
 * `undefined` rather than `false`, because "could not open the target" says
 * nothing about the renderer, and treating it as a failure would close a page
 * on the strength of a transient attach error.
 */
async function probeOnce(
  client: CdpSocket,
  info: TargetInfo,
  timeoutMs: number,
  deadline: number,
): Promise<boolean | undefined> {
  const remaining = Math.max(500, deadline - Date.now());
  const attached = await client.send(
    "Target.attachToTarget",
    { targetId: info.targetId, flatten: true },
    undefined,
    Math.min(timeoutMs, remaining),
  );
  const sessionId = (attached.result as { sessionId?: string } | undefined)?.sessionId;
  if (attached.error || sessionId === undefined) return undefined;
  const evaluated = await client.send(
    "Runtime.evaluate",
    { expression: LIVENESS_EXPRESSION, returnByValue: true },
    sessionId,
    Math.min(timeoutMs, remaining),
  );
  // Detached either way, so the sweep leaves no sessions behind for the connect
  // that follows it to trip over.
  void client.send("Target.detachFromTarget", { sessionId }, undefined, 1_000);
  return evaluated.error === undefined;
}

/** Run `worker` over `items` with a fixed number in flight at once. */
async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Find the page and iframe targets whose renderers have stopped answering.
 *
 * Two passes, and the shape is what keeps this from closing healthy pages. The
 * first pass probes everything with limited concurrency; only the targets that
 * fail it are retried, serially, until they answer or exhaust the attempt
 * budget. A page that is merely busy under load therefore costs one wasted
 * probe and is left alone, while a genuinely wedged renderer, which is silent
 * rather than slow, fails every attempt and is reported.
 *
 * Measured the hard way: an earlier version probed everything in parallel once
 * and closed four healthy pages (npm, GitHub, MDN and an iframe) belonging to a
 * running mission, because a burst of parallel probes overloaded Steel's single
 * CDP proxy and the results were not even stable between two passes.
 */
export async function findUnresponsiveTargets(
  cdpUrl: string,
  options: HealthOptions = {},
): Promise<{ hung: HungTarget[]; checked: number; skipped?: string }> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  let client: CdpSocket;
  try {
    client = await CdpSocket.open(cdpUrl, Math.max(1_000, Math.min(5_000, budgetMs)));
  } catch (error) {
    return { hung: [], checked: 0, skipped: (error as Error).message };
  }

  try {
    const listed = await client.send("Target.getTargets", {}, undefined, Math.max(1_000, deadline - Date.now()));
    if (listed.error) return { hung: [], checked: 0, skipped: `Target.getTargets: ${listed.error}` };
    const infos = ((listed.result as { targetInfos?: TargetInfo[] } | undefined)?.targetInfos ?? [])
      .filter((info) => info.type === "page" || info.type === "iframe");

    // Pass one: everything, a few at a time.
    const first = await mapLimited(infos, concurrency, (info) => probeOnce(client, info, probeTimeoutMs, deadline));

    // Only the failures are retried, and one at a time, so a retry is not
    // competing with other probes for the proxy.
    const suspects = infos.filter((_, index) => first[index] === false);
    const hung: HungTarget[] = [];
    for (const info of suspects) {
      let wedged = true;
      for (let attempt = 1; attempt < attempts; attempt++) {
        if (Date.now() >= deadline) break;
        const answered = await probeOnce(client, info, probeTimeoutMs, deadline);
        // `undefined` means the attach failed, which is not evidence either way.
        // A real answer clears the suspicion; only silence keeps it.
        if (answered !== false) { wedged = false; break; }
      }
      if (wedged && Date.now() < deadline) hung.push({ targetId: info.targetId, url: info.url, type: info.type });
    }

    return { hung, checked: infos.length };
  } finally {
    client.close();
  }
}

/**
 * Close targets by id, answering with the ones that closed.
 *
 * The same direct-CDP path as the probe, for the same reason: this runs when
 * Playwright cannot connect, so it cannot be built on Playwright.
 */
export async function closeTargets(cdpUrl: string, targets: HungTarget[], budgetMs = 5_000): Promise<HungTarget[]> {
  if (targets.length === 0) return [];
  const deadline = Date.now() + budgetMs;
  let client: CdpSocket;
  try {
    client = await CdpSocket.open(cdpUrl, Math.max(1_000, Math.min(5_000, budgetMs)));
  } catch {
    return [];
  }
  try {
    const results = await Promise.all(targets.map(async (target) => {
      const closed = await client.send(
        "Target.closeTarget",
        { targetId: target.targetId },
        undefined,
        Math.max(500, deadline - Date.now()),
      );
      const ok = (closed.result as { success?: boolean } | undefined)?.success === true;
      return ok ? target : undefined;
    }));
    return results.filter((entry): entry is HungTarget => entry !== undefined);
  } finally {
    client.close();
  }
}

/**
 * Close every page whose renderer has stopped answering.
 *
 * Called before a connect, and on the periodic sweep, so a wedged page is
 * cleared before it can make the next attach impossible rather than after.
 *
 * Best effort by design: a sweep that cannot run reports why and returns, and
 * the attach that follows reports its own failure. Throwing here would replace a
 * real connect error with a diagnostic one, which is worse than saying nothing.
 */
export async function resetUnresponsiveTargets(
  cdpUrl: string,
  options: HealthOptions = {},
): Promise<HealthReport> {
  const started = Date.now();
  const { hung, checked, skipped } = await findUnresponsiveTargets(cdpUrl, options);
  if (skipped !== undefined) {
    return { checked, hung: [], closed: [], elapsedMs: Date.now() - started, skipped };
  }
  const closed = await closeTargets(cdpUrl, hung, Math.max(1_000, (options.budgetMs ?? DEFAULT_BUDGET_MS) - (Date.now() - started)));
  return { checked, hung, closed, elapsedMs: Date.now() - started };
}
