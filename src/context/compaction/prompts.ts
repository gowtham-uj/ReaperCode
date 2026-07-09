import type { SessionEntry } from "../../session/session-manager.js";

/**
 * Compaction prompt construction.
 *
 * Reaper mirrors the reference agent's compaction flow at this level:
 *   - build a previous-summary merge prompt when an earlier compaction
 *     entry already exists in the trimmed range;
 *   - render a split-turn partial summary when a tool result message was
 *     split by the compaction boundary (so the next turn still sees what
 *     the previous turn was doing when it returned).
 */

export interface CompactionPromptInput {
  entries: SessionEntry[];
  previousSummary?: string | undefined;
  splitTurn?: SplitTurnContext | undefined;
}

export interface SplitTurnContext {
  /** The leaf entry that was kept on the retained side of the cut. */
  keptEntry: SessionEntry;
  /** True when a tool result for a tool call started in the dropped side was truncated. */
  partialToolResult: boolean;
}

/** Build a system prompt for compaction summarization that includes prior context. */
export function buildCompactionSystemPrompt(input: { previousSummary?: string | undefined }): string {
  const parts = [
    "You are summarizing a Reaper session so the next turn can continue safely.",
    "Return JSON in the form {\"summary\": string} with neutral wording — never mention the reference project name.",
  ];
  if (input.previousSummary && input.previousSummary.trim().length > 0) {
    parts.push(
      "A previous compaction summary exists for this session. Fold its key facts into the new summary rather than discarding them, but write a single coherent paragraph instead of appending verbatim.",
      `Previous summary:\n${input.previousSummary}`,
    );
  }
  return parts.join("\n\n");
}

/** Build the user-prompt payload: the entries plus split-turn metadata. */
export function buildCompactionUserPrompt(input: CompactionPromptInput): string {
  const payload = {
    entries: input.entries,
    ...(input.splitTurn ? { splitTurn: renderSplitTurn(input.splitTurn) } : {}),
  };
  return JSON.stringify(payload).slice(0, 80_000);
}

function renderSplitTurn(context: SplitTurnContext): string {
  const keptType = context.keptEntry.type;
  const keptId = context.keptEntry.id;
  const partialToolResult = context.partialToolResult;
  return [
    `kept_entry_id: ${keptId}`,
    `kept_entry_type: ${keptType}`,
    `partial_tool_result: ${partialToolResult}`,
    partialToolResult
      ? "The compaction boundary fell inside a tool result message. Capture the visible portion of the tool output and explicitly note that the result was truncated by compaction."
      : "No partial tool result crossed the boundary.",
  ].join("\n");
}

/** Build a fallback split-turn summary suitable for inclusion in the heuristic summary. */
export function buildSplitTurnNote(input: SplitTurnContext): string {
  if (!input.partialToolResult) return "";
  const keptId = input.keptEntry.id;
  return `[Split-turn] A tool result was truncated by compaction. The next kept entry id is ${keptId}; downstream turns should treat the tool result as partial.`;
}