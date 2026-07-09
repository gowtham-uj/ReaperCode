/**
 * context/full-summary.ts — full-summarization compaction for Reaper.
 *
 * Mirrors cc-haha's `compactConversation` (splitless, full-replace) ported
 * to Reaper's GraphState. Algorithm:
 *
 *   1. Build a summarization prompt from BASE_COMPACT_PROMPT (9 sections
 *      covering intent, concepts, files, errors, problem-solving,
 *      user messages, pending tasks, current work, optional next step).
 *   2. If a fork is available, ask a child agent to summarize while
 *      sharing the parent's prompt cache (cacheSafeParams). Otherwise
 *      summarize inline with the same prompt.
 *   3. On PTL during the summarize call, truncate the input by removing
 *      oldest API-round groups and retry up to MAX_PTL_RETRIES times.
 *   4. On success, replace the conversation with:
 *        [boundary, summary, attachments...]
 *      where attachments are:
 *        - fileAttachments  — re-read the N most-recent files (default 5)
 *        - planAttachment   — current plan_file_reference
 *        - skillAttachments — invoked skills, recent first, budgeted
 *        - deferredToolAttachments — re-emit deferred-tools delta
 *        - agentListAttachments   — re-emit agent listing
 *        - mcpInstructionAttachments — re-emit MCP instructions
 *
 * The summary is stored in the transcript (no standalone .summary file),
 * consistent with cc-haha.
 *
 * The 9-section schema and the `CreatePlanAttachmentIfNeeded` pattern are
 * ported from cc-haha (`src/services/compact/prompt.ts:61-143`).
 */

import { normalizeToolResult } from "../tools/tool-result.js";

export interface FullSummaryOptions {
  /** Token softCap (e.g. 270_000). Used for cache-sharing fork. */
  softCap: number;
  /** Max most-recent files to re-attach (default 5). */
  maxFilesToRestore?: number;
  /** Token budget for re-attached files (default 50_000). */
  postCompactFileTokenBudget?: number;
  /** Max PTL retries during summarize (default 3). */
  maxPtlRetries?: number;
  /** Minimum chars before a tool result is eligible for head/tail drop. */
  minCharsForPtlDrop?: number;
}

export interface FullSummaryResult {
  /** The summary text. */
  summary: string;
  /** True if the conversation was actually replaced. */
  performed: boolean;
  /** Number of tool results that were dropped on PTL retry. */
  ptlDrops: number;
  /** Chars saved by the cut. */
  savedChars: number;
  /** Chars saved by PTL drops specifically. */
  savedCharsFromPtl: number;
  /** Number of files re-attached post-cut. */
  reattachedFiles: number;
  /** Number of new context messages after the cut. */
  newContextMessages: number;
}

const DEFAULT_MAX_FILES = 5;
const DEFAULT_POST_COMPACT_FILE_BUDGET = 50_000;
const DEFAULT_MAX_PTL_RETRIES = 3;
const DEFAULT_MIN_PTL_DROP = 200;

const BASE_COMPACT_PROMPT = `<analysis>
Begin with a detailed thinking block.
</analysis>
<summary>
1. Primary Request and Intent
   The user's overarching request, the task they gave you, and the high-level goal.

2. Key Technical Concepts
   Key technical decisions, frameworks, language versions, important patterns.

3. Files and Code Sections
   Critical file paths, line ranges, function names, with brief purpose notes.

4. Errors and fixes
   Any errors encountered and the specific fixes applied.

5. Problem Solving
   Approaches that didn't work and why; current direction.

6. All user messages
   Every user message verbatim, in order, with timestamps if known.

7. Pending Tasks
   Explicit TODO items, ordered by the user's stated priority.

8. Current Work
   The very latest thing you were doing right before this summary; what file you were touching, what command you just ran, what you were about to do next.

9. Optional Next Step
   The single concrete next thing you would do, given the conversation. Not "the user said to" — the actual action.
</summary>`;

const NO_TOOLS_PREAMBLE = "Respond with text only. Do not call any tools.";

/**
 * Group messages into API rounds. Mirrors cc-haha's `groupMessagesByApiRound`:
 * a round is an assistant message + its tool calls + the tool results.
 * Used by PTL head-truncation.
 */
function groupMessagesByApiRound(messages: Array<{ role: string }>): Array<{ start: number; end: number }> {
  const rounds: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < messages.length) {
    const start = i;
    const m = messages[i]!;
    i += 1;
    // After a user message, an assistant message can have tool_calls; then
    // one or more tool results follow. Group them all into one round.
    if (m.role === "user" && i < messages.length && messages[i]?.role === "assistant") {
      // consume the assistant
      i += 1;
      // consume the assistant's tool results
      while (i < messages.length && messages[i]?.role === "tool") i += 1;
    } else if (m.role === "assistant") {
      // consume the assistant's tool results
      while (i < messages.length && messages[i]?.role === "tool") i += 1;
    }
    rounds.push({ start, end: i - 1 });
  }
  return rounds;
}

function truncateHeadForPTL(messages: Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: unknown[] }>, minChars: number, tokenGap: number): { messages: typeof messages; dropped: number; savedChars: number } {
  // Drop oldest API-round groups whose total content is >= minChars.
  const rounds = groupMessagesByApiRound(messages);
  const sortedDescendingByContent = rounds
    .map((r) => ({
      range: r,
      chars: messages.slice(r.start, r.end + 1).reduce((s, mm) => s + ((mm.content as string | undefined)?.length ?? 0), 0),
    }))
    .filter((r) => r.chars >= minChars)
    .sort((a, b) => b.chars - a.chars);
  let dropped = 0;
  let savedChars = 0;
  const indicesToDrop = new Set<number>();
  // Cap the number of rounds we'll drop in one call to prevent infinite loops.
  const MAX_ROUNDS_PER_TRUNCATE = 16;
  for (const r of sortedDescendingByContent.slice(0, MAX_ROUNDS_PER_TRUNCATE)) {
    for (let i = r.range.start; i <= r.range.end; i += 1) indicesToDrop.add(i);
    savedChars += r.chars;
    dropped += 1;
  }
  const kept = messages.filter((_, i) => !indicesToDrop.has(i));
  return { messages: kept, dropped, savedChars };
}

/**
 * The summarizer call. We do not have a child-agent fork in Reaper's
 * `mainAgent` path yet, so we summarize inline. The summarizer prompt is
 * built from `BASE_COMPACT_PROMPT` plus the actual conversation
 * serialized as a JSONL of role+content. The summary must be returned
 * wrapped in <summary>…</summary> blocks.
 *
 * NOTE: this function is called by `tryFullSummarization` and expects an
 * `infer` callback that can call the model. The caller wires the model's
 * completion API.
 */
export interface SummariserInput {
  /** Serialised conversation to summarize. */
  conversation: string;
  /** Previous attempts (for retry prompts). */
  previousSummary?: string;
  /** Optional retry marker (e.g. PTL marker). */
  retryMarker?: string;
  /** Model-inference callback returning a single text completion. */
  infer: (prompt: string) => Promise<string>;
  /** Max output tokens for the summarizer. */
  maxOutputTokens?: number;
}

export async function runSummariser(input: SummariserInput): Promise<{ text: string; ptlRecovered: boolean }> {
  const prompt = [
    NO_TOOLS_PREAMBLE,
    "",
    BASE_COMPACT_PROMPT,
    "",
    "## Conversation to summarize",
    "",
    "```jsonl",
    input.conversation,
    "```",
    input.retryMarker ? `\nNote: ${input.retryMarker}\n` : "",
    input.previousSummary ? `Previous attempt (truncated, expand/improve):\n${input.previousSummary}\n` : "",
  ].join("\n");
  const text = await input.infer(prompt);
  return { text, ptlRecovered: Boolean(input.retryMarker) };
}

/**
 * Format a normalised compact summary block, stripping analysis block.
 */
export function extractSummary(text: string): string {
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (m) return m[1]!.trim();
  // Fall back: strip the analysis block if present, return rest.
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

function totalChars(messages: Array<{ content?: string; tool_calls?: Array<{ function: { arguments: string } }> }>): number {
  let s = 0;
  for (const m of messages) {
    if (typeof m.content === "string") s += m.content.length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) s += (tc.function?.arguments ?? "").length;
    }
  }
  return s;
}

function conversationToJsonl(messages: Array<{ role: string; content?: string; tool_call_id?: string; name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role;
    if (m.tool_call_id && m.name) {
      lines.push(JSON.stringify({ role: "tool", name: m.name, content: m.content ?? "" }));
    } else if (m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        lines.push(JSON.stringify({ role: "assistant", tool_name: tc.function.name, args: tc.function.arguments }));
      }
      if (m.content) lines.push(JSON.stringify({ role: "assistant", content: m.content }));
    } else {
      lines.push(JSON.stringify({ role, content: m.content ?? "" }));
    }
  }
  return lines.join("\n");
}

function buildBoundaryMarker(messagesBeforeCut: number, summaryChars: number): string {
  return `[Reaper context boundary] ${messagesBeforeCut} prior messages → ${summaryChars}-char summary. ` +
    "Continue from the current work; do NOT re-read prior files unless needed.";
}

/**
 * Extract durable progress hints from the pre-cut conversation so the
 * model can resume instead of replaying the whole required sequence.
 */
export function extractPostCompactProgressHints(
  messagesBeforeCut: Array<{
    role: string;
    content?: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  }>,
): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const add = (hint: string) => {
    if (seen.has(hint)) return;
    seen.add(hint);
    hints.push(hint);
  };

  let sawBashCat = false;
  const viewed = new Set<string>();
  const written = new Set<string>();

  for (const m of messagesBeforeCut) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        if (name === "bash") {
          const cmd = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : "";
          if (/\bcat\b/.test(cmd) && !/\|\s*(?:head|tail)\b/.test(cmd)) sawBashCat = true;
        } else if (name === "file_view" || name === "read_file") {
          if (typeof args.path === "string" && args.path.trim()) viewed.add(args.path.trim());
        } else if (name === "write_file") {
          if (typeof args.path === "string" && args.path.trim()) written.add(args.path.trim());
        }
      }
    }
  }

  if (sawBashCat) add("large bash cat already ran (output may be head/tailed on disk) — do not re-cat unless needed");
  if (viewed.size > 0) {
    const preview = [...viewed].slice(0, 6).join(", ");
    add(`already viewed: ${preview}${viewed.size > 6 ? ` (+${viewed.size - 6} more)` : ""} — resume from next unfinished step`);
  }
  if (written.size > 0) {
    const preview = [...written].slice(0, 8).join(", ");
    add(`already wrote: ${preview}${written.size > 8 ? ` (+${written.size - 8} more)` : ""} — do not rewrite unless correcting`);
  }
  return hints;
}

/**
 * Re-attach the N most-recent unique file paths referenced in
 * `messagesBeforeCut`. Each re-attachment is a synthetic user message
 * containing a brief summary marker; the model re-reads the actual file
 * via file_view if it needs the contents.
 *
 * NOTE: this is a soft re-anchor. cc-haha re-reads the actual file bytes
 * (up to 50K-token budget) and re-injects them. We could do that too,
 * but it requires hitting the filesystem from this module. For now we
 * emit a "Re-read X if needed" marker per recent file.
 */
function reattachRecentFiles(
  messagesBeforeCut: Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>,
  maxFiles: number,
): Array<{ role: "user"; content: string }> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let i = messagesBeforeCut.length - 1; i >= 0 && paths.length < maxFiles * 4; i -= 1) {
    const m = messagesBeforeCut[i]!;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.function.name === "file_view" || tc.function.name === "file_edit" || tc.function.name === "read_file") {
          try {
            const args = JSON.parse(tc.function.arguments) as { path?: string };
            if (args.path && !seen.has(args.path)) {
              seen.add(args.path);
              paths.unshift(args.path);
            }
          } catch { /* ignore */ }
        }
      }
    }
  }
  const top = paths.slice(0, maxFiles);
  const progress = extractPostCompactProgressHints(messagesBeforeCut as any);
  const parts: string[] = [];
  if (progress.length > 0) {
    parts.push(
      "[Post-compact progress] Already done before this cut — resume at the next unfinished step:",
      ...progress.map((h, i) => `  ${i + 1}. ${h}`),
    );
  }
  if (top.length > 0) {
    parts.push(
      "[Post-compact re-anchor] Files touched recently. Re-read with `file_view` only if you still need contents:",
      ...top.map((p, i) => `  ${i + 1}. ${p}`),
    );
  }
  if (parts.length === 0) return [];
  return [{ role: "user", content: parts.join("\n") }];
}

/**
 * Re-emit deferred tools, agent listing, MCP instructions as a single
 * placeholder. The real cc-haha path uses Delta attachments vs an empty
 * current set; we emit a small marker so the model knows to call
 * `search_tools` for any tools it needs.
 */
function reattachDeferredTools(): Array<{ role: "user"; content: string }> {
  return [
    {
      role: "user",
      content: "[Post-compact re-anchor] Deferred tools, agent listings, and MCP instructions were cleared by the cut. `search_tools` returns the current tool set.",
    },
  ];
}

/**
 * Try full summarization on `liveConversation`. If the conversation
 * exceeds `thresholdTokens` (50% of `softCap` by default) and the
 * summarizer succeeds, return the new compact conversation. Otherwise
 * return null.
 *
 * This is the "auto-compact" path; the caller (engine) decides when to
 * trigger it. We do NOT trigger from the shake path — the shake path is
 * the cheap, non-LLM prune; full-summarization is the expensive fallback
 * that runs when shake has done all it can.
 */
export async function tryFullSummarization(
  liveConversation: Array<{ role: string; content?: string; tool_call_id?: string; name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>,
  options: FullSummaryOptions & { infer: (prompt: string) => Promise<string>; thresholdTokens?: number },
): Promise<FullSummaryResult | null> {
  const maxFiles = options.maxFilesToRestore ?? DEFAULT_MAX_FILES;
  const postBudget = options.postCompactFileTokenBudget ?? DEFAULT_POST_COMPACT_FILE_BUDGET;
  const maxPtl = options.maxPtlRetries ?? DEFAULT_MAX_PTL_RETRIES;
  const minChars = options.minCharsForPtlDrop ?? DEFAULT_MIN_PTL_DROP;
  const threshold = options.thresholdTokens ?? Math.floor(options.softCap * 0.5);

  // Pre-cut stats
  const preChars = totalChars(liveConversation);
  const preTokens = Math.ceil(preChars / 4);
  if (preTokens < threshold) return null;

  // Run summarizer (with PTL retry loop).
  let ptlDrops = 0;
  let savedCharsFromPtl = 0;
  let working = [...liveConversation];
  let summaryText = "";
  let lastPtlErr = "";
  for (let attempt = 0; attempt <= maxPtl; attempt += 1) {
    const jsonl = conversationToJsonl(working);
    const retryMarker = attempt > 0 ? `PTL on attempt ${attempt}; prior context too long. Trim further.` : undefined;
    const previousSummary = attempt > 0 ? summaryText : undefined;
    try {
      const { text } = await runSummariser({
        conversation: jsonl,
        ...(retryMarker !== undefined ? { retryMarker } : {}),
        ...(previousSummary !== undefined ? { previousSummary } : {}),
        infer: options.infer,
      });
      summaryText = extractSummary(text);
      if (summaryText.length > 20) break;
      lastPtlErr = `summary too short (${summaryText.length} chars) on attempt ${attempt}`;
    } catch (err) {
      lastPtlErr = (err as Error).message;
    }
    // PTL retry: truncate head of `working` and try again.
    const targetChars = Math.floor(totalChars(working as any) * 0.2);
    const truncated = truncateHeadForPTL(working as any, minChars, targetChars);
    working = truncated.messages as typeof working;
    ptlDrops += truncated.dropped;
    savedCharsFromPtl += truncated.savedChars;
    if (working.length === 0) break;
  }

  if (summaryText.length < 20) {
    // Summariser failed. Caller should fall back to PTL-recovery or abort.
    return {
      summary: lastPtlErr ? `[full-summary failed: ${lastPtlErr}]` : "[full-summary failed: no summary]",
      performed: false,
      ptlDrops,
      savedChars: 0,
      savedCharsFromPtl,
      reattachedFiles: 0,
      newContextMessages: 0,
    };
  }

  // Build the new conversation: [boundary, summary, attachments...].
  const reattached = reattachRecentFiles(liveConversation, maxFiles);
  const deferred = reattachDeferredTools();
  const newMessages: Array<{ role: string; content?: string }> = [
    { role: "user", content: buildBoundaryMarker(liveConversation.length, summaryText.length) },
    { role: "user", content: `Summary of prior context:\n\n${summaryText}` },
    ...reattached,
    ...deferred,
  ];

  const newChars = totalChars(newMessages as any);
  const savedChars = Math.max(0, preChars - newChars);
  return {
    summary: summaryText,
    performed: true,
    ptlDrops,
    savedChars,
    savedCharsFromPtl,
    reattachedFiles: reattached.length,
    newContextMessages: newMessages.length,
  };
}

/**
 * Convenience: build the new conversation from a summary result without
 * re-running the summarizer. Used when the caller already has a summary
 * in hand and just wants the post-compact message list.
 */
/**
 * Build the post-compact conversation, placed AFTER the system prompt
 * and BEFORE the model's next turn.
 *
 * Placed (in order):
 *   1. Boundary marker  — tells the model that context was compacted.
 *      Without this marker the model can't tell whether the summary
 *      is "prior work" or "the entire conversation", which leads to
 *      it re-deriving things from scratch or ignoring the summary.
 *   2. Summary           — the 9-section LLM-generated summary.
 *      Carries user intent, work history, files touched, errors hit,
 *      and the precise next step so the model can pick up without
 *      re-deriving anything.
 *   3. Re-anchored files — paths touched in the prior turn (read with
 *      file_view). If the model needs current contents it can re-read
 *      them with `file_view`. We list PATHS only, not full contents,
 *      to keep the post-compact budget bounded.
 *   4. Last user request — preserved verbatim. This is critical: the
 *      summary replaces all EARLIER user messages and ALL prior tool
 *      calls, but the LAST user message is the model's current task
 *      and must remain so the model knows what to actually do. We
 *      detect it as the most recent user-role message in `priorConv`
 *      and re-inject it.
 *   5. Deferred-tool delta — re-emit deferred-tools ring so the model
 *      remembers which tool families it can pull in on demand.
 *
 * The engine caller passes only the live-conversation USER + TOOL
 * messages (not the system prompt, which it injects separately), so
 * the result is correctly positioned AFTER `turnRequest.system` in
 * the model's request envelope and only contains content that lives
 * inside the `messages` array.
 */
export function buildPostCompactMessages(
  summary: string,
  liveConversation: Array<{ role: string; content?: string; tool_call_id?: string; name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>,
  options: FullSummaryOptions,
): Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }> {
  const reattached = reattachRecentFiles(liveConversation, options.maxFilesToRestore ?? DEFAULT_MAX_FILES);
  const deferred = reattachDeferredTools();
  // Preserve the most recent user-role message — it's the model's
  // current task and survives the summary replacing all earlier user
  // messages + tool calls.
  let lastUserTask: { role: "user"; content?: string } | undefined;
  for (let i = liveConversation.length - 1; i >= 0; i -= 1) {
    const m = liveConversation[i]!;
    if (m.role === "user" && typeof m.content === "string" && m.content.length > 0) {
      lastUserTask = { role: "user", content: m.content };
      break;
    }
  }
  return [
    { role: "user", content: buildBoundaryMarker(liveConversation.length, summary.length) },
    { role: "user", content: `Summary of prior context:\n\n${summary}` },
    ...reattached,
    ...deferred,
    ...(lastUserTask ? [lastUserTask] : []),
  ];
}

/**
 * Re-export the constants so config files can reference them.
 */
export const FULL_SUMMARY_DEFAULTS = {
  maxFilesToRestore: DEFAULT_MAX_FILES,
  postCompactFileTokenBudget: DEFAULT_POST_COMPACT_FILE_BUDGET,
  maxPtlRetries: DEFAULT_MAX_PTL_RETRIES,
  minCharsForPtlDrop: DEFAULT_MIN_PTL_DROP,
} as const;

// Re-export normalizeToolResult for convenience (used by tests).
export { normalizeToolResult };