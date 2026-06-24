/**
 * Reactive Compact: splits message history into groups and selectively
 * strips low-importance groups without a remote summarization call.
 */

import type { ToolResult } from "../../tools/types.js";

export interface ReactiveCompactInput {
  toolResults: ToolResult[];
  /** Max entries to retain (default 40) */
  maxRetained?: number;
}

export interface ReactiveCompactOutput {
  toolResults: ToolResult[];
  droppedCount: number;
}

export function reactiveCompact(input: ReactiveCompactInput): ReactiveCompactOutput {
  const maxRetained = input.maxRetained ?? 40;
  if (input.toolResults.length <= maxRetained) {
    return { toolResults: input.toolResults, droppedCount: 0 };
  }

  // Score each result by importance
  const scored = input.toolResults.map((result, index) => ({
    result,
    index,
    score: scoreImportance(result, index, input.toolResults.length),
  }));

  // Always keep the first 5 and last 15
  const headCount = 5;
  const tailCount = 15;
  const mustKeep = new Set<number>();
  for (let i = 0; i < Math.min(headCount, scored.length); i++) mustKeep.add(i);
  for (let i = Math.max(headCount, scored.length - tailCount); i < scored.length; i++) mustKeep.add(i);

  // From the middle, keep the highest-scored ones
  const middle = scored.slice(headCount, Math.max(headCount, scored.length - tailCount));
  middle.sort((a, b) => b.score - a.score);
  const remainingSlots = Math.max(0, maxRetained - mustKeep.size);
  for (let i = 0; i < Math.min(remainingSlots, middle.length); i++) {
    mustKeep.add(middle[i]!.index);
  }

  // Rebuild in original order
  const retained: ToolResult[] = [];
  for (let i = 0; i < input.toolResults.length; i++) {
    if (mustKeep.has(i)) {
      retained.push(input.toolResults[i]!);
    }
  }

  return {
    toolResults: retained,
    droppedCount: input.toolResults.length - retained.length,
  };
}

function scoreImportance(result: ToolResult, index: number, total: number): number {
  let score = 0;

  // Recency bias
  score += (index / total) * 30;

  // Failures are important
  if (!result.ok) score += 50;

  // Writes are important
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) {
    score += 40;
  }

  // Shell commands that mutate state
  if (result.name === "run_shell_command" && result.ok) {
    const cmd = (result.args as Record<string, unknown> | undefined)?.cmd?.toString().toLowerCase() ?? "";
    if (/\b(npm|yarn|pnpm|cargo|pip|go|prisma|npx|generate|mkdir|rm|mv|cp)\b/.test(cmd)) {
      score += 30;
    } else {
      score += 10;
    }
  }

  // Reads are moderately important but less than writes
  if (["read_file", "view_file", "grep_search"].includes(result.name)) {
    score += 15;
  }

  // list_directory and skim_file are low importance
  if (["list_directory", "skim_file"].includes(result.name)) {
    score += 5;
  }

  // Short outputs are less likely to be critical
  const chars = estimateChars(result);
  if (chars < 200) score -= 5;
  if (chars > 2000) score += 5;

  return score;
}

function estimateChars(result: ToolResult): number {
  if (!result.ok) {
    return (result.error?.message ?? "").length;
  }
  const rendered = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  return rendered.length;
}
