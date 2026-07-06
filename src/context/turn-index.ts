/**
 * context/turn-index.ts — durable turn index for cross-session continuity.
 *
 * For days-long autonomous operation, the engine needs to be able to
 * reconstruct what happened in a session, even after a restart. This
 * module maintains `.reaper/turn-index.jsonl` — one JSON row per turn
 * (user message, assistant message, or tool call). The rows include
 * char counts, tool names, and SHA-256 of the content so duplicate
 * turns can be detected.
 *
 * Layout:
 *   .reaper/turn-index.jsonl
 *     { ts, kind: "user", session_id, run_id, turn_id, content_sha, chars }
 *     { ts, kind: "assistant", session_id, run_id, turn_id, content_sha, chars }
 *     { ts, kind: "tool_call", session_id, run_id, turn_id, tool_name, content_sha, chars }
 *     { ts, kind: "tool_result", session_id, run_id, turn_id, tool_name, content_sha, chars, ok }
 *     ...
 *
 * Querying the index: the engine can replay the last N turns on resume
 * via `readRecentTurns(workspaceRoot, n)`. Or summarize N turns into a
 * brief context re-anchor.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export type TurnKind = "user" | "assistant" | "tool_call" | "tool_result" | "system" | "summary";

export interface TurnIndexRow {
  ts: string;
  kind: TurnKind;
  session_id: string;
  run_id: string;
  turn_id: string;
  tool_name?: string;
  content_sha?: string;
  chars?: number;
  ok?: boolean;
  metadata?: Record<string, unknown>;
}

function turnIndexPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".reaper", "turn-index.jsonl");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function recordTurn(
  workspaceRoot: string,
  row: Omit<TurnIndexRow, "ts"> & { ts?: string },
): Promise<void> {
  const dir = path.join(workspaceRoot, ".reaper");
  await mkdir(dir, { recursive: true });
  const full: TurnIndexRow = {
    ts: row.ts ?? new Date().toISOString(),
    ...row,
  };
  await appendFile(turnIndexPath(workspaceRoot), `${JSON.stringify(full)}\n`, "utf8");
}

export async function recordUserTurn(
  workspaceRoot: string,
  params: { sessionId: string; runId: string; turnId: string; content: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await recordTurn(workspaceRoot, {
    kind: "user",
    session_id: params.sessionId,
    run_id: params.runId,
    turn_id: params.turnId,
    content_sha: sha256(params.content),
    chars: params.content.length,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

export async function recordAssistantTurn(
  workspaceRoot: string,
  params: { sessionId: string; runId: string; turnId: string; content: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await recordTurn(workspaceRoot, {
    kind: "assistant",
    session_id: params.sessionId,
    run_id: params.runId,
    turn_id: params.turnId,
    content_sha: sha256(params.content),
    chars: params.content.length,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

export async function recordToolTurn(
  workspaceRoot: string,
  params: {
    kind: "tool_call" | "tool_result";
    sessionId: string;
    runId: string;
    turnId: string;
    toolName: string;
    content: string;
    ok?: boolean;
  },
): Promise<void> {
  await recordTurn(workspaceRoot, {
    kind: params.kind,
    session_id: params.sessionId,
    run_id: params.runId,
    turn_id: params.turnId,
    tool_name: params.toolName,
    content_sha: sha256(params.content),
    chars: params.content.length,
    ...(params.ok !== undefined ? { ok: params.ok } : {}),
  });
}

export interface TurnIndexOptions {
  /** Filter by session_id. */
  sessionId?: string;
  /** Filter by minimum ts (inclusive). */
  since?: string;
  /** Filter by kind. */
  kind?: TurnKind | TurnKind[];
  /** Max rows to return. Default 100. */
  maxRows?: number;
  /** Reverse order (newest first). */
  newestFirst?: boolean;
}

export function readTurnIndex(
  workspaceRoot: string,
  options: TurnIndexOptions = {},
): TurnIndexRow[] {
  const p = turnIndexPath(workspaceRoot);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const rows: TurnIndexRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TurnIndexRow;
      if (options.sessionId && r.session_id !== options.sessionId) continue;
      if (options.since && r.ts < options.since) continue;
      if (options.kind) {
        const kinds = Array.isArray(options.kind) ? options.kind : [options.kind];
        if (!kinds.includes(r.kind)) continue;
      }
      rows.push(r);
    } catch {
      // skip
    }
  }
  if (options.newestFirst) rows.reverse();
  return rows.slice(0, options.maxRows ?? 100);
}

export function turnIndexStats(workspaceRoot: string): {
  total: number;
  byKind: Record<string, number>;
  totalChars: number;
  sessions: Set<string>;
} {
  // Pass maxRows: Number.MAX_SAFE_INTEGER to read all rows.
  const rows = readTurnIndex(workspaceRoot, { maxRows: Number.MAX_SAFE_INTEGER });
  const byKind: Record<string, number> = {};
  let totalChars = 0;
  const sessions = new Set<string>();
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    totalChars += r.chars ?? 0;
    sessions.add(r.session_id);
  }
  return { total: rows.length, byKind, totalChars, sessions };
}

export async function readRecentTurnsAsync(
  workspaceRoot: string,
  n: number,
  options: TurnIndexOptions = {},
): Promise<TurnIndexRow[]> {
  return readTurnIndex(workspaceRoot, { ...options, maxRows: n, newestFirst: true });
}
