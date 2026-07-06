/**
 * context/time-microcompact.ts — time-based microcompaction.
 *
 * cc-haha's `maybeTimeBasedMicrocompact` clears tool results that are
 * old enough that the provider's prompt-cache prefix would have rolled
 * over anyway. Reaper doesn't know the exact cache TTL, so we use a
 * conservative threshold (default 5 minutes; on by default for
 * days-long sessions).
 *
 * Strategy: replace any tool result that is older than `gapMs` with a
 * short `[Old tool result content cleared]` placeholder, except for the
 * most recent `keepRecent` tool results.
 *
 * For resumed sessions: if a tool result has no `timestamp` field, we
 * treat it as fresh (no clear). Otherwise an old resumed message would
 * be cleared based on `nowMs`.
 *
 * Tracks per-message metadata in `__mc_cleared: true` so the operation
 * is **idempotent**: re-running it on a previously-cleared message
 * finds the placeholder and skips it (no double-saving of chars).
 */

export interface TimeMicrocompactOptions {
  /** Maximum age (in ms) for a tool result to survive. */
  gapMs?: number;
  /** Alias for gapMs (kept for backward compatibility). */
  gapThresholdMs?: number;
  /** Always keep the most recent N tool results. */
  keepRecent?: number;
  /** Current wall-clock (ms since epoch). */
  nowMs?: number;
  /** Toggle off the whole pass. Default: on (for days-long sessions). */
  enabled?: boolean;
}

export interface TimeMicrocompactResult {
  /** Number of tool results cleared (placeholder inserted). */
  clearedResults: number;
  /** Number of chars saved (negative is impossible — it accumulates). */
  savedChars: number;
}

export const TIME_MICROCOMPACT_PLACEHOLDER = "[Old tool result content cleared]";

const DEFAULT_GAP_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_KEEP_RECENT = 5;

/**
 * Time-based microcompact. Mutates `messages` in place.
 *
 * @param messages The conversation (mutated in place).
 * @param optionsOrNow Either an options object or `nowMs` (number).
 *
 * Returns counts of cleared results and saved chars. Skips messages
 * already cleared (idempotent).
 */
export function maybeTimeBasedMicrocompact(
  messages: Array<Record<string, unknown>>,
  optionsOrNow?: TimeMicrocompactOptions | number,
): TimeMicrocompactResult {
  // Resolve options — accept (messages, options) or (messages, nowMs) signatures.
  let options: TimeMicrocompactOptions;
  if (typeof optionsOrNow === "number") {
    options = { nowMs: optionsOrNow };
  } else {
    options = optionsOrNow ?? {};
  }
  if (options.enabled === false) return { clearedResults: 0, savedChars: 0 };
  const gap = options.gapMs ?? options.gapThresholdMs ?? DEFAULT_GAP_MS;
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  const nowMs = options.nowMs ?? Date.now();

  // Walk the messages and identify tool results.
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "tool") toolIndices.push(i);
  }
  // Eligible = the older `keepRecent`-and-prior tool results.
  const eligible = toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecent));

  let cleared = 0;
  let savedChars = 0;
  for (const i of eligible) {
    const msg = messages[i]!;
    // Idempotency: skip messages already cleared.
    if ((msg as Record<string, unknown>).__mc_cleared === true) continue;
    // Need a real timestamp to know age. Missing timestamps = "treat as fresh".
    const ts = (msg as { timestamp?: number }).timestamp;
    if (typeof ts !== "number") continue;
    if (nowMs - ts < gap) continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    const originalSize = content.length;
    if (originalSize < 50) continue; // skip tiny results
    msg.content = TIME_MICROCOMPACT_PLACEHOLDER;
    msg.__mc_cleared = true;
    msg.__mc_cleared_at = nowMs;
    msg.__mc_original_size = originalSize;
    savedChars += originalSize - TIME_MICROCOMPACT_PLACEHOLDER.length;
    cleared += 1;
  }
  return { clearedResults: cleared, savedChars };
}
