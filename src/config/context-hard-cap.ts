/**
 * Reaper hard context cap.
 *
 * Even when a provider advertises a 1M (or larger) window, Reaper only
 * budgets up to this many tokens for live conversation context. SoftCap
 * defaults to this value and is clamped to it everywhere it is resolved.
 */
export const REAPER_CONTEXT_HARD_CAP_TOKENS = 270_000;

/** Default softCap — same as the hard cap unless a lower override is set. */
export const REAPER_DEFAULT_SOFT_CAP_TOKENS = REAPER_CONTEXT_HARD_CAP_TOKENS;

/**
 * Clamp a softCap candidate into (0, REAPER_CONTEXT_HARD_CAP_TOKENS].
 * Non-finite / non-positive values return the default softCap.
 */
export function clampSoftCapTokens(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return REAPER_DEFAULT_SOFT_CAP_TOKENS;
  }
  return Math.min(REAPER_CONTEXT_HARD_CAP_TOKENS, Math.floor(value));
}
