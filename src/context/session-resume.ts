/**
 * context/session-resume.ts — cross-session continuity.
 *
 * For days-long autonomous operation, the engine must be able to resume
 * from a previous session. This module reads the persistent-summary
 * index and the turn-index to produce a "re-anchor" message that the
 * engine prepends to the live conversation on boot.
 *
 * The re-anchor has three parts:
 *
 *   1. The most recent persistent summary (if any) — full-summarized
 *      description of the entire prior session.
 *   2. The last K user/assistant/tool turns from the turn-index — raw
 *      recency so the model remembers what it was just doing.
 *   3. Optional memory-search hits when a "resume query" is provided —
 *      keyword-relevant past summaries.
 *
 * The caller (engine boot) builds the live conversation like this:
 *
 *   liveConversation = [
 *     { role: "user", content: RE_ANCHOR },
 *     ...prior turns from turn-index (re-hydrated as user/assistant/tool)...
 *     { role: "user", content: thisRunUserPrompt },
 *   ]
 */

import { readTurnIndex, type TurnIndexRow } from "./turn-index.js";
import { loadSummaryBody, loadAllSummaries, type PersistentSummary } from "./persistent-summary.js";

export interface SessionResumeOptions {
  /** Number of recent turns to re-hydrate. Default 20. */
  recentTurns?: number;
  /** Max chars of recent-turn content to re-hydrate. Default 50_000. */
  maxRecentChars?: number;
  /** Optional resume query for memory search. */
  resumeQuery?: string;
  /** Filter by session_id. Default: most recent. */
  sessionId?: string;
}

export interface SessionResumeResult {
  /** Re-anchor user message to prepend. */
  reAnchor: string;
  /** Re-hydrated messages (already in {role, content, ...} format) to prepend. */
  rehydratedMessages: Array<{ role: string; content?: string; name?: string; tool_call_id?: string }>;
  /** Persistent summary used (if any). */
  summary: PersistentSummary | null;
  /** Stats for diagnostics. */
  stats: {
    recentTurns: number;
    recentChars: number;
    summariesAvailable: number;
  };
}

const DEFAULT_RECENT_TURNS = 20;
const DEFAULT_MAX_RECENT_CHARS = 50_000;

export function buildSessionResume(
  workspaceRoot: string,
  options: SessionResumeOptions = {},
): SessionResumeResult {
  const recentTurns = options.recentTurns ?? DEFAULT_RECENT_TURNS;
  const maxRecentChars = options.maxRecentChars ?? DEFAULT_MAX_RECENT_CHARS;
  const allSummaries = loadAllSummaries(workspaceRoot);
  const summariesAvailable = allSummaries.length;
  // Most recent summary (filtered by sessionId if provided).
  const filtered = options.sessionId
    ? allSummaries.filter((s) => s.sessionId === options.sessionId)
    : allSummaries;
  const summary = filtered.length > 0 ? filtered[filtered.length - 1]! : null;

  // Re-hydrate the last K turns.
  const recent = readTurnIndex(workspaceRoot, {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    maxRows: recentTurns,
    newestFirst: false, // chronological
  });
  const rehydratedMessages: Array<{ role: string; content?: string; name?: string; tool_call_id?: string }> = [];
  let recentChars = 0;
  for (const row of recent) {
    const rowChars = row.chars ?? 0;
    if (recentChars + rowChars > maxRecentChars) break;
    rehydratedMessages.push(turnRowToMessage(row));
    recentChars += rowChars;
  }

  // Build the re-anchor user message.
  const reAnchor = buildReAnchorMessage(summary, rehydratedMessages.length);

  return {
    reAnchor,
    rehydratedMessages,
    summary,
    stats: { recentTurns: rehydratedMessages.length, recentChars, summariesAvailable },
  };
}

function turnRowToMessage(row: TurnIndexRow): { role: string; content?: string; name?: string; tool_call_id?: string } {
  // turn-index rows are metadata-only; we re-anchor with a compact
  // description of what the turn was, not the full content. The model
  // can call `read_file` to fetch the actual content if needed.
  const ts = row.ts;
  switch (row.kind) {
    case "user":
      return { role: "user", content: `[prior @ ${ts}] ${summarize(row)}` };
    case "assistant":
      return { role: "assistant", content: `[prior assistant @ ${ts}] ${summarize(row)}` };
    case "tool_call":
      return { role: "assistant", content: `[prior tool_call @ ${ts}] ${row.tool_name ?? "unknown"}` };
    case "tool_result":
      return { role: "tool", tool_call_id: row.turn_id, name: row.tool_name ?? "tool", content: summarize(row) };
    case "summary":
      return { role: "user", content: `[prior summary @ ${ts}] ${summarize(row)}` };
    case "system":
    default:
      return { role: "system", content: `[prior @ ${ts}] ${summarize(row)}` };
  }
}

function summarize(row: TurnIndexRow): string {
  if (row.content_sha) return `sha:${row.content_sha} (${row.chars ?? 0} chars)`;
  if (row.tool_name) return `tool:${row.tool_name} (${row.chars ?? 0} chars)`;
  return `${row.kind} (${row.chars ?? 0} chars)`;
}

function buildReAnchorMessage(summary: PersistentSummary | null, recentCount: number): string {
  const ts = new Date().toISOString();
  if (!summary) {
    return [
      `[Reaper session re-anchor @ ${ts}]`,
      "No persistent summary from a prior session was found.",
      `Re-hydrating ${recentCount} recent turn(s) from .reaper/turn-index.jsonl.`,
      "Use `read_file` to fetch any prior content by SHA reference.",
    ].join("\n");
  }
  return [
    `[Reaper session re-anchor @ ${ts}]`,
    `Most recent persistent summary: ${summary.id} (created ${summary.createdAt})`,
    `Saved ${summary.savedChars} chars at that cut. ${summary.reattachedFiles} files re-attached.`,
    `Re-hydrating ${recentCount} recent turn(s) from .reaper/turn-index.jsonl.`,
    "",
    "Summary preview (first 500 chars):",
    "```",
    summary.body.slice(0, 500),
    "```",
    "Use `read_file` on the .reaper/summaries/<id>.md to read the full summary.",
  ].join("\n");
}

export async function buildSessionResumeWithBody(
  workspaceRoot: string,
  options: SessionResumeOptions = {},
): Promise<SessionResumeResult> {
  const r = buildSessionResume(workspaceRoot, options);
  if (r.summary) {
    // Replace preview with full body.
    const full = await loadSummaryBody(workspaceRoot, r.summary.id);
    if (full) r.summary = { ...r.summary, body: full };
  }
  return r;
}
