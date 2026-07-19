/**
 * stream-events — live JSONL event mirror for external harnesses.
 *
 * When enabled (`--stream-events` on `reaper exec run`, or
 * `REAPER_STREAM_EVENTS=1` in the environment), every trajectory
 * entry is ALSO written to stdout as one JSON object per line, at the
 * moment it is logged. stdout becomes a pure JSONL event stream;
 * human-readable output (live model text, turn headers, the exec
 * summary) moves to stderr so consumers can `reaper exec run ... |
 * jq` without any filtering.
 *
 * The mirror is universal by construction: it lives inside
 * `TrajectoryLogger.write` / `writeBatch`, which every engine,
 * executor, and wiring code path already routes through. Entries are
 * redacted with the same `redactSecrets` pass the on-disk JSONL gets,
 * so a secret never reaches stdout that would not have reached the
 * trajectory file.
 */

import { redactSecrets } from "./redaction.js";

export function streamEventsEnabled(): boolean {
  const v = process.env.REAPER_STREAM_EVENTS;
  return v === "1" || v === "true";
}

let stdoutErrorHookInstalled = false;

/**
 * Install a one-time `process.stdout.on("error", …)` listener so a
 * downstream pipe closing (EPIPE) cannot crash the model loop. The
 * live stream is fire-and-forget from the consumer's perspective.
 */
function ensureStdoutErrorHook(): void {
  if (stdoutErrorHookInstalled) return;
  stdoutErrorHookInstalled = true;
  const out = process.stdout as unknown as { on?: (e: "error", cb: (err: unknown) => void) => unknown };
  if (typeof out.on === "function") {
    try {
      out.on("error", () => { /* swallowed for the event-stream path */ });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Mirror one trajectory entry to stdout as a single JSONL line.
 * No-op unless stream events are enabled. Swallows all write errors
 * (EPIPE when a downstream pipe is closed, etc.) so a consumer
 * disconnect can never crash the model loop.
 */
export function emitStreamEvent(entry: unknown): void {
  if (!streamEventsEnabled()) return;
  ensureStdoutErrorHook();
  try {
    process.stdout.write(`${JSON.stringify(redactSecrets(entry))}\n`);
  } catch {
    /* stdout is fire-and-forget for the consumer; never break the run */
  }
}
