/**
 * TokenBudgetTracker — per-turn + cumulative token usage accounting.
 *
 * Phase T2.7: the engine now surfaces token spend per turn and over the
 * whole run so users can see real cost / context pressure, not just a
 * final number when the session ends.
 *
 * Two layers of accounting:
 *
 *   1. **Per-call** — every `GenerateResult` carries a `usage` block
 *      with `inputTokens` and `outputTokens` (and optionally
 *      `cacheReadTokens` / `cacheWriteTokens` for providers that
 *      report them). The tracker captures these and accumulates them.
 *
 *   2. **Per-turn** — a "turn" in Reaper is one model call plus its
 *      tool-result loop. The tracker is started at the beginning of
 *      every turn and a snapshot is taken at the end. The snapshot
 *      reports the delta for that turn plus the running cumulative
 *      total for the session.
 *
 * The tracker is intentionally allocation-light: it stores only
 * numbers. Snapshots are plain objects the caller can put on a
 * `token_budget` trajectory event directly.
 *
 * If a provider does not report usage (today: some LiteLLM routes,
 * mock providers for tests), the per-call slot is silently skipped.
 * The cumulative total still reflects everything reported.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TokenBudgetSnapshot {
  /** Sum of input tokens reported during this turn (and not before). */
  inputTokens: number;
  /** Sum of output tokens reported during this turn (and not before). */
  outputTokens: number;
  /** Sum of cache-read tokens reported during this turn (and not before). */
  cacheReadTokens: number;
  /** Sum of cache-write tokens reported during this turn (and not before). */
  cacheWriteTokens: number;
  /** Number of model calls reported during this turn. */
  callCount: number;
  /** Cumulative input tokens across the entire tracker lifetime. */
  cumulativeInputTokens: number;
  /** Cumulative output tokens across the entire tracker lifetime. */
  cumulativeOutputTokens: number;
  /** Cumulative cache-read tokens across the entire tracker lifetime. */
  cumulativeCacheReadTokens: number;
  /** Cumulative cache-write tokens across the entire tracker lifetime. */
  cumulativeCacheWriteTokens: number;
  /** Cumulative model calls across the entire tracker lifetime. */
  cumulativeCallCount: number;
  /** ISO timestamp of when this snapshot was taken. */
  takenAt: string;
}

interface CumulativeTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  callCount: number;
}

function newCumulative(): CumulativeTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    callCount: 0,
  };
}

export class TokenBudgetTracker {
  private cumulative: CumulativeTotals = newCumulative();
  // Snapshot of cumulative totals at the moment the current turn
  // started. The per-turn delta is `cumulative - turnStartSnapshot`.
  private turnStartSnapshot: CumulativeTotals = newCumulative();

  /** Start a new turn. Subsequent `record` calls are attributed to
   *  this turn until the next `beginTurn` call. */
  beginTurn(): void {
    this.turnStartSnapshot = { ...this.cumulative };
  }

  /** Record one model call's usage. Both the per-turn accumulator
   *  and the cumulative totals are updated. Missing usage blocks
   *  are a no-op. */
  record(usage: TokenUsage | undefined | null): void {
    if (!usage) return;
    if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
      this.cumulative.inputTokens += usage.inputTokens;
    }
    if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
      this.cumulative.outputTokens += usage.outputTokens;
    }
    if (typeof usage.cacheReadTokens === "number" && Number.isFinite(usage.cacheReadTokens)) {
      this.cumulative.cacheReadTokens += usage.cacheReadTokens;
    }
    if (typeof usage.cacheWriteTokens === "number" && Number.isFinite(usage.cacheWriteTokens)) {
      this.cumulative.cacheWriteTokens += usage.cacheWriteTokens;
    }
    this.cumulative.callCount += 1;
  }

  /** Snapshot the current turn. Returns both the turn delta and the
   *  cumulative totals at this instant. Does NOT advance the turn
   *  marker — call `beginTurn` again when the next turn starts. */
  snapshot(): TokenBudgetSnapshot {
    const cum = this.cumulative;
    const start = this.turnStartSnapshot;
    return {
      inputTokens: cum.inputTokens - start.inputTokens,
      outputTokens: cum.outputTokens - start.outputTokens,
      cacheReadTokens: cum.cacheReadTokens - start.cacheReadTokens,
      cacheWriteTokens: cum.cacheWriteTokens - start.cacheWriteTokens,
      callCount: cum.callCount - start.callCount,
      cumulativeInputTokens: cum.inputTokens,
      cumulativeOutputTokens: cum.outputTokens,
      cumulativeCacheReadTokens: cum.cacheReadTokens,
      cumulativeCacheWriteTokens: cum.cacheWriteTokens,
      cumulativeCallCount: cum.callCount,
      takenAt: new Date().toISOString(),
    };
  }

  /** Reset to zero. Use between sessions or in tests. */
  reset(): void {
    this.cumulative = newCumulative();
    this.turnStartSnapshot = newCumulative();
  }
}

// ---------------------------------------------------------------------------
// Provider-shape normalize helper
// ---------------------------------------------------------------------------

/**
 * Build a TokenUsage from a parsed provider response. Accepts either
 * the Anthropic Messages shape (`input_tokens`/`output_tokens`) or
 * the OpenAI Chat shape (`prompt_tokens`/`completion_tokens`).
 *
 * `total_tokens` is intentionally ignored — we always derive totals
 * from input+output to avoid double-counting when the provider is
 * sloppy about what `total_tokens` means (OpenAI: sum; Anthropic:
 * not present; OpenRouter: includes reasoning tokens).
 *
 * Returns `undefined` when no usage info is present so callers can
 * pass the result straight to `tracker.record`.
 */
export function tokenUsageFromResponse(
  response:
    | {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      }
    | null
    | undefined,
): TokenUsage | undefined {
  if (!response || !response.usage) return undefined;
  const u = response.usage;
  const input = typeof u.input_tokens === "number"
    ? u.input_tokens
    : typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
  const output = typeof u.output_tokens === "number"
    ? u.output_tokens
    : typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const result: TokenUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  };
  // Anthropic-specific cache fields.
  if (typeof u.cache_read_input_tokens === "number") {
    result.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (typeof u.cache_creation_input_tokens === "number") {
    result.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  return result;
}
