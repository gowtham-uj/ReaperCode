/**
 * context/session-store.ts — named persistent sessions.
 *
 * Each named session lives at `<workspaceRoot>/.reaper/sessions/<name>/`.
 * The directory is the session's "brain" — everything needed to resume
 * after a process exit, machine reboot, or days-long pause.
 *
 * Layout:
 *   .reaper/sessions/<name>/
 *     session.json                  # metadata
 *     conversation.jsonl            # full live conversation
 *     turn-index.jsonl              # durable turn log
 *     trajectory.jsonl              # merged trajectory events
 *     summaries/                    # full-summarization cuts
 *       <id>.md
 *       index.jsonl
 *     state/                        # typed state blobs
 *       plan.json
 *       todo.json
 *       run-context.json
 *     meta.jsonl                    # one-line-per-run audit
 *
 * The workspace-level `index.json` maps session names → metadata for
 * fast listing.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export interface SessionMetadata {
  id: string;
  name: string;
  workspaceRoot: string;
  createdAt: string;
  lastActiveAt: string;
  runCount: number;
  totalModelCalls: number;
  totalToolCalls: number;
  lastModel?: string;
  lastProvider?: string;
  status: "active" | "completed" | "paused" | "errored";
  /** Initial prompt that started the session (the user's first message). */
  initialPrompt?: string;
}

export interface SessionListEntry {
  name: string;
  metadata: SessionMetadata;
  /** Path to the session directory. */
  dir: string;
  /** Approximate disk usage in bytes. */
  sizeBytes: number;
}

function sessionsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".reaper", "sessions");
}

function sessionDir(workspaceRoot: string, name: string): string {
  return path.join(sessionsRoot(workspaceRoot), name);
}

function sessionJsonPath(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "session.json");
}

function conversationPath(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "conversation.jsonl");
}

function turnIndexPath(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "turn-index.jsonl");
}

function trajectoryPath(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "trajectory.jsonl");
}

function metaPath(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "meta.jsonl");
}

function summariesDir(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "summaries");
}

function stateDir(workspaceRoot: string, name: string): string {
  return path.join(sessionDir(workspaceRoot, name), "state");
}

function indexPath(workspaceRoot: string): string {
  return path.join(sessionsRoot(workspaceRoot), "index.json");
}

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function dirSizeSync(dir: string): number {
  // Cheap recursive size via stat; for very large directories this
  // could be slow, but at 1000+ events/min we already do this once
  // per list. For 100s of sessions this is fine.
  let total = 0;
  try {
    const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSizeSync(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  } catch {
    // ignore
  }
  return total;
}

export interface CreateSessionInput {
  name: string;
  workspaceRoot: string;
  initialPrompt: string;
  model?: string;
  provider?: string;
}

export async function createSession(input: CreateSessionInput): Promise<SessionMetadata> {
  if (!isValidSessionName(input.name)) {
    throw new Error(`Invalid session name: ${input.name}. Must match ${SESSION_NAME_RE}`);
  }
  const dir = sessionDir(input.workspaceRoot, input.name);
  if (existsSync(dir)) {
    throw new Error(`Session "${input.name}" already exists. Use loadSession() to resume it, or pass --continue.`);
  }
  await mkdir(summariesDir(input.workspaceRoot, input.name), { recursive: true });
  await mkdir(stateDir(input.workspaceRoot, input.name), { recursive: true });
  const now = new Date().toISOString();
  const meta: SessionMetadata = {
    id: randomUUID(),
    name: input.name,
    workspaceRoot: input.workspaceRoot,
    createdAt: now,
    lastActiveAt: now,
    runCount: 0,
    totalModelCalls: 0,
    totalToolCalls: 0,
    ...(input.model ? { lastModel: input.model } : {}),
    ...(input.provider ? { lastProvider: input.provider } : {}),
    status: "active",
    initialPrompt: input.initialPrompt,
  };
  await writeFile(sessionJsonPath(input.workspaceRoot, input.name), JSON.stringify(meta, null, 2), "utf8");
  await appendFile(metaPath(input.workspaceRoot, input.name), `${JSON.stringify({ ts: now, event: "session_created", run_id: meta.id, model: meta.lastModel, provider: meta.lastProvider })}\n`, "utf8");
  await updateIndex(input.workspaceRoot, meta);
  return meta;
}

export async function loadSession(
  workspaceRoot: string,
  name: string,
): Promise<SessionMetadata | null> {
  const p = sessionJsonPath(workspaceRoot, name);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as SessionMetadata;
  } catch {
    return null;
  }
}

export async function updateSessionMetadata(
  workspaceRoot: string,
  meta: SessionMetadata,
): Promise<void> {
  await writeFile(sessionJsonPath(workspaceRoot, meta.name), JSON.stringify(meta, null, 2), "utf8");
  await updateIndex(workspaceRoot, meta);
}

async function updateIndex(workspaceRoot: string, meta: SessionMetadata): Promise<void> {
  const idx = indexPath(workspaceRoot);
  let entries: Array<{ name: string; metadata: SessionMetadata }> = [];
  if (existsSync(idx)) {
    try {
      const raw = await readFile(idx, "utf8");
      entries = JSON.parse(raw) as Array<{ name: string; metadata: SessionMetadata }>;
    } catch {
      entries = [];
    }
  }
  entries = entries.filter((e) => e.name !== meta.name);
  entries.push({ name: meta.name, metadata: meta });
  await mkdir(sessionsRoot(workspaceRoot), { recursive: true });
  await writeFile(idx, JSON.stringify(entries, null, 2), "utf8");
}

export interface ListSessionsOptions {
  /** Filter by status. */
  status?: SessionMetadata["status"];
  /** Sort by lastActiveAt descending (newest first). Default true. */
  newestFirst?: boolean;
}

export function listSessions(
  workspaceRoot: string,
  options: ListSessionsOptions = {},
): SessionListEntry[] {
  const idx = indexPath(workspaceRoot);
  if (!existsSync(idx)) return [];
  let entries: Array<{ name: string; metadata: SessionMetadata }>;
  try {
    entries = JSON.parse(readFileSync(idx, "utf8")) as Array<{ name: string; metadata: SessionMetadata }>;
  } catch {
    return [];
  }
  let result: SessionListEntry[] = entries
    .filter((e) => !options.status || e.metadata.status === options.status)
    .map((e) => ({
      name: e.name,
      metadata: e.metadata,
      dir: sessionDir(workspaceRoot, e.name),
      sizeBytes: dirSizeSync(sessionDir(workspaceRoot, e.name)),
    }));
  if (options.newestFirst !== false) {
    result.sort((a, b) => b.metadata.lastActiveAt.localeCompare(a.metadata.lastActiveAt));
  }
  return result;
}

export async function deleteSession(workspaceRoot: string, name: string): Promise<void> {
  const dir = sessionDir(workspaceRoot, name);
  if (existsSync(dir)) {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
  const idx = indexPath(workspaceRoot);
  if (existsSync(idx)) {
    try {
      const raw = await readFile(idx, "utf8");
      const entries = JSON.parse(raw) as Array<{ name: string }>;
      await writeFile(idx, JSON.stringify(entries.filter((e) => e.name !== name), null, 2), "utf8");
    } catch {
      // ignore
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Conversation persistence
// ─────────────────────────────────────────────────────────────────────────

/** Append a message to the session's conversation log. */
export async function appendSessionMessage(
  workspaceRoot: string,
  name: string,
  message: Record<string, unknown>,
): Promise<void> {
  const dir = sessionDir(workspaceRoot, name);
  await mkdir(dir, { recursive: true });
  await appendFile(conversationPath(workspaceRoot, name), `${JSON.stringify(message)}\n`, "utf8");
}

/** Load the full conversation from disk, returning [] if absent. */
export function loadSessionConversation(
  workspaceRoot: string,
  name: string,
): Array<Record<string, unknown>> {
  const p = conversationPath(workspaceRoot, name);
  if (!existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Turn index — delegates to the same on-disk layout as turn-index.ts
// ─────────────────────────────────────────────────────────────────────────

export function loadSessionTurnIndexPath(workspaceRoot: string, name: string): string {
  return turnIndexPath(workspaceRoot, name);
}

export function loadSessionTrajectoryPath(workspaceRoot: string, name: string): string {
  return trajectoryPath(workspaceRoot, name);
}

export function loadSessionSummariesDir(workspaceRoot: string, name: string): string {
  return summariesDir(workspaceRoot, name);
}

export function loadSessionStateDir(workspaceRoot: string, name: string): string {
  return stateDir(workspaceRoot, name);
}

export function loadSessionMetaPath(workspaceRoot: string, name: string): string {
  return metaPath(workspaceRoot, name);
}

export async function recordSessionRun(
  workspaceRoot: string,
  name: string,
  runSummary: {
    runId: string;
    startedAt: string;
    endedAt: string;
    status: "completed" | "errored" | "aborted";
    modelCalls: number;
    toolCalls: number;
    prompt: string;
  },
): Promise<void> {
  await appendFile(
    metaPath(workspaceRoot, name),
    `${JSON.stringify({ ts: runSummary.endedAt, event: "run_completed", ...runSummary })}\n`,
    "utf8",
  );
  const meta = await loadSession(workspaceRoot, name);
  if (meta) {
    meta.runCount += 1;
    meta.totalModelCalls += runSummary.modelCalls;
    meta.totalToolCalls += runSummary.toolCalls;
    meta.lastActiveAt = runSummary.endedAt;
    meta.status = runSummary.status === "completed" ? "active" : runSummary.status === "aborted" ? "paused" : "errored";
    await updateSessionMetadata(workspaceRoot, meta);
  }
}
