/**
 * Abort controller registry. The TUI owns one AbortController per
 * in-flight prompt and exposes it to the input layer (Esc) and the
 * hook subscribers (PreToolUse payloads).
 *
 * After a prompt resolves, the slot is reset via `reset()` so the
 * next submit gets a fresh signal. Until reset, the (now-aborted)
 * signal can still be inspected — useful for deciding whether the
 * next submit should be queued or rejected.
 */

export interface AbortSlot {
  /** The current AbortSignal. Use this when starting a new prompt. */
  signal: AbortSignal;
  /** Abort the current prompt. */
  abort: () => void;
  /** Replace the current AbortController with a fresh one. */
  reset: () => void;
}

export function makeAbortSlot(): AbortSlot {
  let ctrl = new AbortController();
  return {
    get signal() {
      return ctrl.signal;
    },
    abort: () => ctrl.abort(),
    reset: () => {
      if (!ctrl.signal.aborted) return;
      ctrl = new AbortController();
    },
  };
}