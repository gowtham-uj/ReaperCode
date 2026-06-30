/**
 * Compose multiple AbortSignals into a single AbortSignal that aborts when
 * any of the inputs abort. Equivalent to the standard `AbortSignal.any()`
 * static but with a fallback for older runtimes.
 *
 * Used by Reaper provider clients to compose the internal request-timeout
 * signal with the external `runtime.abortSignal` so a user-cancel or
 * timeout-bounded cancellation propagates immediately through the fetch
 * boundary.
 */
export function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => Boolean(s));
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  const anyAbort =
    typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any(defined)
      : (() => {
          const ctrl = new AbortController();
          for (const signal of defined) {
            if (signal.aborted) {
              ctrl.abort(signal.reason);
              break;
            }
            signal.addEventListener(
              "abort",
              () => ctrl.abort(signal.reason),
              { once: true },
            );
          }
          return ctrl.signal;
        })();
  return anyAbort;
}
