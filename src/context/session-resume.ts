/**
 * context/session-resume.ts — summary-based resume FALLBACK.
 *
 * The PRIMARY cross-run continuity mechanism is the named-session journal
 * (`context/session-journal.ts`): `exec run --session <name>` rehydrates
 * the real prior conversation (latest compaction summary + raw tail).
 *
 * This module is the fallback for UNNAMED runs that share a workspace:
 * it reads the persistent-summary index (`.reaper/summaries/`) written by
 * full_summary compactions and produces a "re-anchor" user message that
 * the engine prepends to the live conversation on boot. It carries no raw
 * turns — only the most recent summary.
 *
 * The caller (engine boot) builds the live conversation like this:
 *
 *   liveConversation = [
 *     { role: "user", content: RE_ANCHOR },
 *     { role: "user", content: thisRunUserPrompt },
 *   ]
 */

import { loadSummaryBody, loadAllSummaries, type PersistentSummary } from "./persistent-summary.js";
import {
  COMPACTION_CHECKPOINT_MESSAGE_NAME,
  COMPACTION_SUMMARY_MESSAGE_NAME,
  COMPACTION_SUMMARY_PREFIX,
  renderCompactionCheckpoint,
} from "./compaction-checkpoint.js";

export interface SessionResumeOptions {
  /** Filter by session_id. Default: most recent. */
  sessionId?: string;
}

export interface SessionResumeResult {
  /** Re-anchor user message to prepend. Empty when nothing to resume. */
  reAnchor: string;
  /** Structured compacted context. Raw prior turns remain journal-only. */
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

export function buildSessionResume(
  workspaceRoot: string,
  options: SessionResumeOptions = {},
): SessionResumeResult {
  const allSummaries = loadAllSummaries(workspaceRoot);
  const summariesAvailable = allSummaries.length;
  // Most recent summary (filtered by sessionId if provided).
  const filtered = options.sessionId
    ? allSummaries.filter((s) => s.sessionId === options.sessionId)
    : allSummaries;
  const summary = filtered.length > 0 ? filtered[filtered.length - 1]! : null;

  return {
    reAnchor: summary ? buildReAnchorMessage(summary) : "",
    rehydratedMessages: [],
    summary,
    stats: { recentTurns: 0, recentChars: 0, summariesAvailable },
  };
}

function buildReAnchorMessage(summary: PersistentSummary): string {
  const ts = new Date().toISOString();
  return [
    `[Reaper session re-anchor @ ${ts}]`,
    `Most recent persistent summary: ${summary.id} (created ${summary.createdAt})`,
    `Saved ${summary.savedChars} chars at that cut. ${summary.reattachedFiles} files re-attached.`,
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
    const full = await loadSummaryBody(workspaceRoot, r.summary.id);
    if (full) r.summary = { ...r.summary, body: full };
    r.reAnchor = [
      `[Reaper session re-anchor @ ${new Date().toISOString()}]`,
      `Restored persistent summary ${r.summary.id} from epoch ${r.summary.epoch ?? 1}.`,
    ].join("\n");
    r.rehydratedMessages = [
      ...(r.summary.checkpoint
        ? [{
            role: "user",
            name: COMPACTION_CHECKPOINT_MESSAGE_NAME,
            content: renderCompactionCheckpoint(r.summary.checkpoint),
          }]
        : []),
      {
        role: "user",
        name: COMPACTION_SUMMARY_MESSAGE_NAME,
        content: `${COMPACTION_SUMMARY_PREFIX}\n\n${r.summary.body}`,
      },
    ];
    r.stats.recentTurns = r.rehydratedMessages.length;
    r.stats.recentChars = r.rehydratedMessages.reduce(
      (total, message) => total + (message.content?.length ?? 0),
      0,
    );
  }
  return r;
}
