/**
 * Context pressure: how full the prompt budget is, as a first-class value.
 *
 * Computed once on the server so every surface (web, CLI, anything later)
 * renders the same number from the same inputs rather than each re-deriving a
 * percentage and disagreeing about the denominator.
 *
 * The distinction this file exists to preserve is between *tokens billed* and
 * *tokens that will occupy the next prompt*. They are not the same number, and
 * using the first as a context meter is why other agents report over 100%.
 * Summing input, cached reads, reasoning, and output counts how much the
 * session has been charged for; the prompt budget is what has to fit. For a
 * live meter the second is the only one that answers the question the user is
 * asking, which is "am I about to run out of room".
 */

/**
 * A context limit and where it came from.
 *
 * `unknown` is a real answer and must be rendered as one. A meter with no
 * limit shows "unknown" rather than inventing a denominator: a wrong window
 * produces a confidently wrong percentage that nobody can trace back to a
 * source, which is worse than showing nothing. The resolution order is
 * explicit config, then provider-reported model metadata, then Reaper's own
 * registry, and then nothing.
 */
export type ContextLimitSource = "config" | "catalog" | "registry" | "unknown";

export interface ResolvedContextLimit {
  /** The model's full window, or null when nothing could tell us. */
  window: number | null;
  source: ContextLimitSource;
}

export interface ContextUsageInput {
  /** Prompt tokens for the request being measured, or its estimate. */
  promptTokens: number;
  /** The model's context window, when known. */
  window: number | null;
  /** Where `window` came from. */
  source?: ContextLimitSource;
  /**
   * The maximum output the request asked for. Subtracted from the limit,
   * because a reservation is part of the budget: a 200k window with a 32k
   * reservation holds about 168k of prompt.
   */
  reservedOutputTokens?: number;
  /** True when `promptTokens` is an estimate rather than a provider count. */
  estimated?: boolean;
  model?: string;
}

export interface ContextUsage {
  model?: string;
  promptTokens: number;
  contextLimit: number | null;
  reservedOutputTokens: number;
  /**
   * Percent, 0 to 100, or null when the limit is unknown.
   *
   * One decimal below 10, whole numbers above. Whole-percent rounding at low
   * usage makes a live meter look frozen: a turn that grows a prompt from
   * 5,064 to 5,899 tokens against a 238k budget moves 2.13% to 2.48%, and both
   * display as "2%", so a user watching an accurate meter sees nothing move
   * and reports it as broken. Above 10% the integer is the useful reading and
   * the extra digit is noise.
   */
  percent: number | null;
  /** `contextLimit - promptTokens`, floored at 0, or null when unknown. */
  remaining: number | null;
  estimated: boolean;
  limitSource: ContextLimitSource;
}

/**
 * Compute context pressure.
 *
 * Pure, so it can be asserted directly and so a caller cannot accidentally
 * depend on ordering or on shared state.
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsage {
  const promptTokens = Math.max(0, Math.floor(input.promptTokens));
  const reserved = Math.max(0, Math.floor(input.reservedOutputTokens ?? 0));
  const source: ContextLimitSource = input.source ?? (input.window === null ? "unknown" : "catalog");

  /*
   * An unknown or non-positive window means no percentage. `Math.max(1, ...)`
   * on the denominator would have made this look safe while producing a
   * number that means nothing: a 0 window would report every request as
   * over-limit. Returning null forces the renderer to say "unknown", which is
   * the honest answer and the one the reader can act on.
   */
  if (input.window === null || !Number.isFinite(input.window) || input.window <= 0) {
    return {
      ...(input.model ? { model: input.model } : {}),
      promptTokens,
      contextLimit: null,
      reservedOutputTokens: reserved,
      percent: null,
      remaining: null,
      estimated: Boolean(input.estimated),
      limitSource: "unknown",
    };
  }

  const contextLimit = Math.max(1, Math.floor(input.window) - reserved);
  /*
   * Clamped. A value above 100 is never information: it means the accounting
   * model disagrees with reality, and showing the user "118%" asks them to
   * interpret an arithmetic problem they cannot see.
   */
  const raw = Math.min(100, (promptTokens / contextLimit) * 100);
  const percent = raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw);
  const remaining = Math.max(0, contextLimit - promptTokens);

  return {
    ...(input.model ? { model: input.model } : {}),
    promptTokens,
    contextLimit,
    reservedOutputTokens: reserved,
    percent,
    remaining,
    estimated: Boolean(input.estimated),
    limitSource: source,
  };
}
