/**
 * context-budget.ts — token-budget decision helpers, ported from
 * oh-my-pi's `resolveThresholdTokens`/`effectiveReserveTokens`.
 *
 * The OMP design rule:
 *
 *   thresholdTokens = clamp(
 *     settings.thresholdTokens ?? contextWindow - reserveTokens,
 *     [1, contextWindow - 1],
 *   )
 *
 * With two refinements:
 *   1. The reserve defaults to `max(15% of contextWindow, 16_384)`.
 *      This guarantees the threshold stays strictly below the
 *      window even for tiny windows (e.g. tests) but reserves a
 *      reasonable prompt+response headroom in production.
 *   2. If a percentage threshold is set, the threshold tokens
 *      resolve to that percentage of the window. Useful for users
 *      who want a soft "fire at 50%" rule rather than a fixed
 *      reserve.
 *
 * Reaper uses these helpers everywhere a decision needs to be in
 * tokens, NOT chars. The bridge layer `legacyCharsToTokens`
 * (Math.ceil(chars / 4)) exists only as a fallback when no
 * tokenizer is registered at boot; production should always pass
 * a real `countTokens` option into `createContextEngineeringHooks`.
 */

export interface ContextBudgetSettings {
  /**
   * Fixed token threshold. If positive, takes priority over
   * percentage-based or reserve-derived thresholds.
   */
  thresholdTokens?: number;
  /**
   * Percentage of contextWindow to use as threshold (1..99). E.g.
   * `50` means "fire compaction when context hits 50% of window".
   */
  thresholdPercent?: number;
  /**
   * Tokens reserved below contextWindow for the next prompt +
   * response. Default = 16_384. Set to 0 to disable.
   */
  reserveTokens?: number;
  /**
   * The model's full context window in tokens.
   */
  contextWindow: number;
}

/** Reserve applied when {@link ContextBudgetSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16_384;
/** Minimum proportional reserve (15% of window) used as fallback when default would saturate the window. */
export const PROPORTIONAL_RESERVE_RATIO = 0.15;

/**
 * Compute the effective reserve tokens, applying the
 * 15%-of-window floor when the default would otherwise consume
 * (nearly) the entire window.
 */
export function effectiveReserveTokens(
  contextWindow: number,
  settings: Pick<ContextBudgetSettings, "reserveTokens">,
): number {
  return Math.max(
    Math.floor(contextWindow * PROPORTIONAL_RESERVE_RATIO),
    settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
  );
}

/**
 * Resolve the threshold tokens for the compaction decision.
 * Mirrors OMP's `resolveThresholdTokens`.
 */
export function resolveThresholdTokens(
  contextWindow: number,
  settings: Pick<ContextBudgetSettings, "thresholdTokens" | "thresholdPercent" | "reserveTokens">,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  // 1. Fixed thresholdTokens takes priority.
  if (
    typeof settings.thresholdTokens === "number" &&
    Number.isFinite(settings.thresholdTokens) &&
    settings.thresholdTokens > 0
  ) {
    return Math.min(contextWindow - 1, Math.max(1, settings.thresholdTokens));
  }
  // 2. Percentage-based.
  if (
    typeof settings.thresholdPercent === "number" &&
    Number.isFinite(settings.thresholdPercent) &&
    settings.thresholdPercent > 0
  ) {
    const pct = Math.min(99, Math.max(1, settings.thresholdPercent));
    return Math.floor(contextWindow * (pct / 100));
  }
  // 3. Reserve-derived (default). If the default would saturate the
  //    window, fall back to the proportional reserve so the threshold
  //    stays strictly below contextWindow - 1.
  const reserve = effectiveReserveTokens(contextWindow, settings);
  return Math.max(0, Math.min(contextWindow - 1, contextWindow - reserve));
}

/**
 * The compaction decision: returns true if `contextTokens` crosses
 * the threshold. Mirrors OMP's `shouldCompact`.
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: ContextBudgetSettings,
): boolean {
  if (contextWindow <= 0) return false;
  const threshold = resolveThresholdTokens(contextWindow, settings);
  return contextTokens > threshold;
}

/**
 * Floor context tokens for the compaction decision by the local
 * estimate of the stored conversation. Mirrors OMP's
 * `compactionContextTokens` — the floor keeps the trigger honest
 * even if a provider-side compression shrinks the wire payload.
 */
export function compactionContextTokens(
  providerContextTokens: number,
  storedConversationEstimate: number,
): number {
  return Math.max(
    Math.max(0, providerContextTokens),
    Math.max(0, storedConversationEstimate),
  );
}

/**
 * Heuristic fallback for the wiring's `countTokens` option. Real
 * production should always inject a real tokenizer (e.g. the
 * runtime gateway's tokenizer). This exists only for the boot
 * path when no tokenizer is registered yet.
 */
export function legacyCharsToTokens(messages: unknown[]): number {
  let chars = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { content?: unknown; tool_calls?: unknown };
    if (typeof msg.content === "string") chars += msg.content.length;
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && typeof tc === "object") {
          const args = (tc as { function?: { arguments?: string } }).function?.arguments;
          if (typeof args === "string") chars += args.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
