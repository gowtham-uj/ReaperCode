/**
 * AdaptiveConcurrencyQueue + globalLlmQueue — process-global LLM
 * concurrency throttling with self-tuning.
 *
 * Tuning rules (corrected after the latency-poisoning incident):
 *
 * 1. **Latency is measured around the model call only**, NOT the
 *    queue wait + model call. The previous version measured wall
 *    time around `queue.add(task)`, so once the queue was at
 *    concurrency=1 the wait time dominated the metric and the
 *    recovery condition (`< 10s`) could never fire — every call
 *    sat on the queue behind the previous one. Now the caller
 *    passes a `latencyFn` that yields the true model duration.
 *
 * 2. **Decay is bounded — TWO consecutive slow calls before drop.**
 *    The previous version used `Math.max(1, this.queue.concurrency
 *    - 1)` per slow call, which combined with measurement bug #1
 *    caused the queue to latch at concurrency=1 forever after a
 *    single >30s call. The fix: require TWO consecutive slow
 *    observations before dropping, and never drop more than one
 *    step at a time.
 *
 * 3. **Recovery is monotonic over time, not per-call.** Once
 *    `globalLlmQueue.reset()` is called (e.g. by the TUI on each
 *    prompt submit) concurrency returns to the maximum
 *    (REAPER_QUEUE_MAX_CONCURRENCY, default 5). The TUI calls
 *    reset() so a slow background subagent call doesn't poison
 *    the interactive prompt path.
 *
 * 4. **Opt-out flag for fully interactive sessions.**
 *    `REAPER_TUI_NO_QUEUE=1` makes `enqueueLlmCall()` skip the
 *    queue entirely and run the task inline. Use this only when
 *    you know the calling site is a single-user interactive prompt
 *    (the TUI's `engine-driver.runPrompt`); it does NOT skip
 *    concurrency throttling for subagents or background tasks.
 *
 * The class is exported for tests; the process-global
 * `globalLlmQueue` singleton is what production code uses.
 */

import PQueue from "p-queue";

type Task<T> = () => Promise<T>;

interface EnqueueOptions {
  /**
   * Optional latency observer. The queue calls this after the
   * task resolves; the returned value (ms) is what the adaptive
   * tuner uses to decide whether to drop or raise concurrency.
   * If omitted, the tuner measures wall time around the queue
   * wait + task — the legacy behavior, kept for callers that
   * genuinely want the queue-wait time included.
   */
  latencyFn?: () => number;
}

export class AdaptiveConcurrencyQueue {
  private readonly queue: PQueue;
  private readonly maxConcurrency: number;
  private readonly minConcurrency: number;
  private lastLatencyMs = 0;
  private consecutiveSlow = 0;

  constructor(
    initialConcurrency = 2,
    options: { maxConcurrency?: number; minConcurrency?: number } = {},
  ) {
    const max = options.maxConcurrency ?? readMaxConcurrency();
    const min = options.minConcurrency ?? 1;
    this.maxConcurrency = max;
    this.minConcurrency = min;
    this.queue = new PQueue({ concurrency: clamp(initialConcurrency, min, max) });
  }

  /**
   * Submit a task. The tuner observes `opts.latencyFn()` (or the
   * wall-clock duration around `queue.add` as a fallback) and
   * adjusts concurrency up/down per the rules above.
   */
  async enqueue<T>(task: Task<T>, opts: EnqueueOptions = {}): Promise<T> {
    const startTime = Date.now();
    try {
      const result = await this.queue.add(task);
      return result as T;
    } finally {
      const observedMs =
        typeof opts.latencyFn === "function" ? opts.latencyFn() : Date.now() - startTime;
      this.lastLatencyMs = observedMs;
      this.adjustConcurrency();
    }
  }

  /**
   * Restore concurrency to the maximum. Called by the TUI on each
   * prompt submit so a single slow background subagent call doesn't
   * permanently throttle the interactive path.
   */
  reset(): void {
    this.queue.concurrency = this.maxConcurrency;
    this.lastLatencyMs = 0;
    this.consecutiveSlow = 0;
  }

  /** Current concurrency — for diagnostics. */
  get concurrency(): number {
    return this.queue.concurrency;
  }

  /** Last observed latency — for diagnostics. */
  get lastObservedLatencyMs(): number {
    return this.lastLatencyMs;
  }

  private adjustConcurrency(): void {
    if (this.lastLatencyMs > SLOW_LATENCY_MS) {
      this.consecutiveSlow += 1;
      // Require TWO consecutive slow calls before dropping — the
      // previous version dropped on the first one, which was the
      // root cause of permanent throttling. A single outlier (cold
      // cache, network blip) must not latch the queue.
      if (this.consecutiveSlow < 2) return;
      const next = Math.max(this.minConcurrency, this.queue.concurrency - 1);
      if (next !== this.queue.concurrency) {
        this.queue.concurrency = next;
      }
      return;
    }
    this.consecutiveSlow = 0;
    if (this.lastLatencyMs < FAST_LATENCY_MS) {
      const next = Math.min(this.maxConcurrency, this.queue.concurrency + 1);
      if (next !== this.queue.concurrency) {
        this.queue.concurrency = next;
      }
    }
  }
}

const SLOW_LATENCY_MS = 30_000;
const FAST_LATENCY_MS = 10_000;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readMaxConcurrency(): number {
  const raw = Number(process.env.REAPER_QUEUE_MAX_CONCURRENCY ?? 5);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}

/**
 * Process-global queue. Tunable via env vars:
 *   REAPER_TUI_NO_QUEUE=1           — bypass the queue entirely
 *                                     (TUI interactive prompts only)
 *   REAPER_QUEUE_MAX_CONCURRENCY=N  — upper bound (default 5)
 */
export const globalLlmQueue = new AdaptiveConcurrencyQueue();

/**
 * True when the TUI is configured to skip the global queue entirely.
 * Read once at module load — set the env var before the TUI process
 * starts.
 */
const TUI_NO_QUEUE = process.env.REAPER_TUI_NO_QUEUE === "1";

/**
 * Convenience wrapper used by `json-response.ts` etc. Honors the
 * `REAPER_TUI_NO_QUEUE` opt-out for interactive sessions. The
 * `latencyFn` is called after the inner task resolves so the tuner
 * measures the actual model-call duration, not the queue wait.
 */
export async function enqueueLlmCall<T>(
  task: () => Promise<T>,
  opts: EnqueueOptions = {},
): Promise<T> {
  if (TUI_NO_QUEUE) {
    const startTime = Date.now();
    try {
      return await task();
    } finally {
      const observedMs =
        typeof opts.latencyFn === "function" ? opts.latencyFn() : Date.now() - startTime;
      // Caller opted out of throttling; record for diagnostics only.
      void observedMs;
    }
  }
  return globalLlmQueue.enqueue(task, opts);
}
