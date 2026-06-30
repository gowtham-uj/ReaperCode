/**
 * Fault-isolation helpers for extensions.
 *
 *   - `withTimeout(promise, ms)` — race the promise against a
 *     timer; never leak the inner promise.
 *   - `runIsolated(fn)` — try/catch wrapper that records the
 *     error as a string instead of throwing.
 *
 * Both are intentionally tiny. No VM, no worker_threads. The
 * guarantee we provide: a thrown or hung extension function cannot
 * crash the host or hang the event loop indefinitely.
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `promise` against a timeout. If the timeout wins, the
 * returned promise resolves to `fallback` (default: a TimeoutError).
 * The inner promise is not awaited past the timeout — its eventual
 * resolution is silently swallowed to prevent unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback?: T): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (fallback !== undefined) resolve(fallback);
      else reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
    // Allow Node to exit even if the timer is still pending.
    if (typeof (timer as { unref?: () => void })?.unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
  return Promise.race([
    promise.catch((e) => {
      if (timer !== undefined) clearTimeout(timer);
      throw e;
    }),
    timeoutPromise,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export type IsolatedResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run `fn` and return either `{ ok: true, value }` or
 * `{ ok: false, error }`. Synchronous throws are caught; async
 * rejections are awaited.
 */
export async function runIsolated<T>(fn: () => T | Promise<T>): Promise<IsolatedResult<T>> {
  try {
    const out = await fn();
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Synchronous variant of `runIsolated` for non-async work. */
export function runIsolatedSync<T>(fn: () => T): IsolatedResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
