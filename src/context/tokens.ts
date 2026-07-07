/**
 * tokens.ts — canonical token estimation / conversion utilities.
 *
 * Reaper's context-engineering pipeline operates in TOKENS, not characters.
 * The 4 chars-per-token average is a reasonable approximation for English
 * code/text and what `tiktoken` would output for `o200k_base` on roughly
 * natural-language + code with some JSON. For more accurate counts we'd
 * shell out to tiktoken locally, but the round-trip is too expensive for
 * the hot path. Use a constant 4 here and document the simplification.
 *
 * Every layer that needs to reason about context budget should:
 *   - Read its limit from `.reaper/config.json runtimeTunables.*` (already
 *     in tokens).
 *   - Compute the actual consumption via `estimateTotalChars()` then
 *     `charsToTokens(chars)` so the comparison is apples-to-apples.
 *
 * NEVER compare a token-budget to a raw character count. If you find
 * yourself writing `if (chars > softCap)`, fix it: convert first.
 */

/** Average characters per token (English code/text heuristic, not exact). */
export const CHARS_PER_TOKEN = 4;

/**
 * Convert a character count to a token count using the canonical ratio.
 * Always Math.ceil — partial tokens still cost a slot in the LLM window.
 */
export function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Inverse — token to char (used when sizing soft-caps derived from tokens). */
export function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

/**
 * Sum the total chars in a messages array (content + tool_call args).
 * Pure-char metric; pair with `charsToTokens()` when comparing to a
 * token softCap.
 */
export function estimateTotalChars(
  messages: ReadonlyArray<{
    content?: unknown;
    tool_calls?: ReadonlyArray<{ function?: { arguments?: unknown } }>;
  }>,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") total += msg.content.length;
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const args = tc?.function?.arguments;
        if (typeof args === "string") total += args.length;
      }
    }
  }
  return total;
}

/**
 * Sum the total tokens in a messages array using the canonical ratio.
 * Use this for any limit comparison that should be in tokens.
 */
export function estimateTotalTokens(messages: Parameters<typeof estimateTotalChars>[0]): number {
  return charsToTokens(estimateTotalChars(messages));
}

/**
 * Convert a percent ratio (0..1+) to a token count given a token softCap.
 * `ratio(0.8) * softCap = tokens used at 80% of budget`.
 */
export function tokensAtRatio(softCapTokens: number, ratio: number): number {
  return Math.floor(softCapTokens * ratio);
}
