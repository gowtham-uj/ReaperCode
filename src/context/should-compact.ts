/**
 * context/should-compact.ts — OMP port of the compaction-trigger
 * decision.
 *
 * In oh-my-pi's `compaction.ts`, `shouldCompact()` is the single gate
 * that every compaction layer (pre-prompt, mid-turn, post-turn)
 * checks before actually firing. The decision is:
 *
 *   tokensUsed > thresholdTokens
 *
 * where thresholdTokens is `softCap - reserve`, with:
 *   - reserve defaults to 16_384 (DEFAULT_RESERVE_TOKENS in OMP)
 *   - reserve falls back to max(1, softCap * 0.15) for tiny windows
 *     (a 16K reserve against a 200-token window is impossible)
 *   - thresholdTokens is clamped to [1, softCap-1]
 *
 * Reaper mirrors the same algorithm so:
 *   - the shake (#6/#7) wiring correctly computes "did shake recover"
 *   - the full-summary (#10) layer only fires when shake can't
 *   - the PTL-recovery (#5) fallback path uses consistent numbers
 *
 * Thresholds are TOKENS, not characters. The `legacyCharsToTokens`
 * heuristic (`chars / 4`) is the O200K base ratio used by Reaper
 * when no real tokenizer is wired.
 */

export interface CompactionTriggerSettings {
  /** Provider-side context window (e.g. 200_000 for MiniMax-M3). */
  softCap: number;
  /** Disable compaction. */
  enabled?: boolean;
  /** Optional explicit threshold override (token count). */
  thresholdTokens?: number;
  /** Optional explicit reserve override (token count). */
  reserveTokens?: number;
}

export const DEFAULT_RESERVE_TOKENS = 16_384;
const MIN_RESERVE_FLOOR_TOKENS = 1;

/**
 * Resolve the effective reserve (OMP port).
 *
 * Default is `DEFAULT_RESERVE_TOKENS` (16K). For tiny context windows
 * (e.g. 200 tokens) the proportional fallback `max(1, softCap * 0.15)`
 * is used so the threshold stays strictly below the window.
 */
export function effectiveReserveTokens(softCap: number, settings?: CompactionTriggerSettings): number {
  return Math.max(MIN_RESERVE_FLOOR_TOKENS, settings?.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/**
 * Resolve the budget reserve used by the threshold (OMP port).
 *
 * Default reserve is `DEFAULT_RESERVE_TOKENS` (16K). For tiny context
 * windows (e.g. a 200-token window with a 16K default reserve would
 * consume the whole window + 80x), the proportional reserve
 * `max(1, softCap * 0.15)` is used so the threshold stays
 * strictly below the window.
 *
 * `resolveBudgetReserveTokens` is what the threshold uses;
 * `effectiveReserveTokens` is a separate helper used by callers
 * that need the configured reserve verbatim (e.g. for telemetry).
 */
export function resolveBudgetReserveTokens(softCap: number, settings?: CompactionTriggerSettings): number {
  const reserveTokens = effectiveReserveTokens(softCap, settings);
  const proportionalReserveTokens = Math.max(MIN_RESERVE_FLOOR_TOKENS, Math.floor(softCap * 0.15));
  // If the default reserve would consume the window (or is unset),
  // fall back to the proportional reserve. Explicit user-chosen
  // reserves always win, even when tiny.
  if (settings?.reserveTokens !== undefined) return reserveTokens;
  if (reserveTokens >= softCap) return proportionalReserveTokens;
  return reserveTokens;
}

/**
 * Resolve the threshold tokens below which compaction never fires.
 *
 * If the settings have `thresholdTokens` set, use that directly. Else
 * fall back to `softCap - budgetReserve`, clamped to [1, softCap - 1].
 */
export function resolveThresholdTokens(softCap: number, settings?: CompactionTriggerSettings): number {
  if (settings && typeof settings.thresholdTokens === "number" && Number.isFinite(settings.thresholdTokens) && settings.thresholdTokens > 0) {
    return Math.min(softCap - 1, Math.max(1, settings.thresholdTokens));
  }
  const reserve = resolveBudgetReserveTokens(softCap, settings);
  return Math.max(0, Math.min(softCap - 1, softCap - reserve));
}

/**
 * Single source of truth: should we compact now?
 * OMP-style gate that all Reaper layers check before invoking
 * the heavy summarization LLM call.
 */
export function shouldCompact(tokensUsed: number, softCap: number, settings?: CompactionTriggerSettings): boolean {
  if (settings && settings.enabled === false) return false;
  if (softCap <= 0) return false;
  const threshold = resolveThresholdTokens(softCap, settings);
  return tokensUsed > threshold;
}

/**
 * Convert char count to tokens using the O200K base heuristic. Used
 * when no real tokenizer is registered. Returns ceiling(count/4).
 */
export function charsToTokensO200kBase(chars: number): number {
  return Math.ceil(chars / 4);
}
