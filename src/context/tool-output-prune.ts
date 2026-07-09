/**
 * context/tool-output-prune.ts — OMP pruneToolOutputs port.
 *
 * Age-based truncation of old tool results outside a protect window.
 * Runs after supersede-prune and before shake so cheap reclaim happens
 * before LLM summarization.
 *
 * Defaults mirror OMP DEFAULT_PRUNE_CONFIG:
 *   protectTokens ≈ 40_000 → protectChars = 160_000
 *   minimumSavings ≈ 20_000 tokens → minSavingsChars = 80_000
 */

export interface ToolOutputPruneOptions {
  /** Keep the newest this many chars of tool output intact. Default 160_000. */
  protectChars?: number;
  /** Only prune when total savings meets this. Default 80_000. */
  minSavingsChars?: number;
  /** Leading messages left untouched (prompt-cache warm prefix). Default 1. */
  warmPrefixCount?: number;
  /** Minimum result size (chars) worth truncating. Default 200. */
  minResultChars?: number;
}

export interface ToolOutputPruneResult {
  pruned: number;
  savedChars: number;
  performed: boolean;
}

const DEFAULT_PROTECT_CHARS = 160_000;
const DEFAULT_MIN_SAVINGS_CHARS = 80_000;
const DEFAULT_MIN_RESULT_CHARS = 200;

function truncatedNotice(originalChars: number): string {
  return `[Output truncated - ~${Math.ceil(originalChars / 4)} tokens]`;
}

/**
 * Truncate older tool-role messages outside the protect window when
 * savings justify it. Mutates `messages` in place.
 */
export function pruneToolOutputs(
  messages: Array<Record<string, unknown>>,
  options: ToolOutputPruneOptions = {},
): ToolOutputPruneResult {
  const protectChars = options.protectChars ?? DEFAULT_PROTECT_CHARS;
  const minSavings = options.minSavingsChars ?? DEFAULT_MIN_SAVINGS_CHARS;
  const warmPrefix = Math.max(0, options.warmPrefixCount ?? 1);
  const minResult = options.minResultChars ?? DEFAULT_MIN_RESULT_CHARS;

  const toolIndices: number[] = [];
  for (let i = warmPrefix; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool") continue;
    if (typeof msg.content !== "string") continue;
    toolIndices.push(i);
  }
  if (toolIndices.length === 0) {
    return { pruned: 0, savedChars: 0, performed: false };
  }

  // Protect newest tool outputs by walking backward until protectChars filled.
  let protectedBudget = 0;
  const protectedSet = new Set<number>();
  for (let k = toolIndices.length - 1; k >= 0; k -= 1) {
    const idx = toolIndices[k]!;
    const content = String(messages[idx]!.content ?? "");
    if (protectedBudget >= protectChars) break;
    protectedSet.add(idx);
    protectedBudget += content.length;
  }

  // Stage candidates oldest-first; apply only if total savings clears min.
  const candidates: Array<{ idx: number; savings: number; notice: string }> = [];
  for (const idx of toolIndices) {
    if (protectedSet.has(idx)) continue;
    const content = String(messages[idx]!.content ?? "");
    if (content.length < minResult) continue;
    const notice = truncatedNotice(content.length);
    const savings = content.length - notice.length;
    if (savings <= 0) continue;
    candidates.push({ idx, savings, notice });
  }

  const totalSavings = candidates.reduce((sum, c) => sum + c.savings, 0);
  if (totalSavings < minSavings || candidates.length === 0) {
    return { pruned: 0, savedChars: 0, performed: false };
  }

  let pruned = 0;
  let savedChars = 0;
  for (const c of candidates) {
    messages[c.idx]!.content = c.notice;
    pruned += 1;
    savedChars += c.savings;
  }
  return { pruned, savedChars, performed: pruned > 0 };
}
