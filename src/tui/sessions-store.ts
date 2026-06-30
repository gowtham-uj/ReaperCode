/**
 * sessions-store — persist + load TUI session metadata.
 *
 * Each session writes a JSON file at
 * `<workspaceRoot>/.reaper/sessions/<sessionId>.json` with the
 * shape below. The /sessions slash command lists the most recent
 * 20. The /resume <id> command hydrates the message list from the
 * session's trajectory file.
 *
 * Session metadata is intentionally minimal — the trajectory itself
 * lives at `trajectoryPath` and is replayed on resume.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionMetadata {
  id: string;
  startedAt: string;
  model: string;
  provider: string;
  promptCount: number;
  messageCount: number;
  trajectoryPath: string;
  /** First user prompt, for display in /sessions list. May be omitted
   *  when the session was opened but never used. */
  firstPrompt?: string | undefined;
}

const SESSIONS_DIRNAME = ".reaper/sessions";

export function sessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, SESSIONS_DIRNAME);
}

export function ensureSessionsDir(workspaceRoot: string): void {
  mkdirSync(sessionsDir(workspaceRoot), { recursive: true });
}

/** Write (or overwrite) session metadata. Idempotent. */
export function saveSession(workspaceRoot: string, meta: SessionMetadata): void {
  ensureSessionsDir(workspaceRoot);
  const path = join(sessionsDir(workspaceRoot), `${meta.id}.json`);
  writeFileSync(path, JSON.stringify(meta, null, 2), "utf8");
}

/** Read a single session's metadata. Returns null if not found. */
export function loadSession(workspaceRoot: string, id: string): SessionMetadata | null {
  const path = join(sessionsDir(workspaceRoot), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionMetadata;
  } catch {
    return null;
  }
}

/** List the most recent N sessions (newest first). */
export function listSessions(workspaceRoot: string, limit = 20): SessionMetadata[] {
  ensureSessionsDir(workspaceRoot);
  const dir = sessionsDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items: SessionMetadata[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), "utf8");
      const meta = JSON.parse(raw) as SessionMetadata;
      items.push(meta);
    } catch {
      /* skip malformed */
    }
  }
  items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return items.slice(0, limit);
}

/**
 * Plain `{role, content}` chat messages extracted from a trajectory
 * JSONL file. Returned in chronological order. Used by `/resume <id>`
 * to re-hydrate the SessionStore so subsequent prompts carry the
 * full conversation history via the priorTurns payload.
 */
export interface HydratedTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Read a session's trajectory file and return its user + assistant
 * text messages in order. Returns null when the file is missing or
 * unreadable. Skips blank lines and lines that aren't valid JSON.
 *
 * Recognised envelopes:
 *   - `{kind: "user_prompt", payload: {prompt: "..."}}` → user turn
 *   - `{kind: "assistant_message", payload: {content: "..."}}` or
 *     `{content: "..."}` at the top level → assistant turn
 *
 * Tool calls and other event kinds are intentionally ignored — we
 * only re-hydrate conversational context, not the full tool audit
 * trail (that's what /history shows).
 */
export function readSessionHistory(trajectoryPath: string): HydratedTurn[] | null {
  if (!trajectoryPath || !existsSync(trajectoryPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(trajectoryPath, "utf8");
  } catch {
    return null;
  }
  const out: HydratedTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let env: Record<string, unknown> | null = null;
    try {
      env = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!env || typeof env !== "object") continue;

    const kind = String(env.kind ?? env.message_type ?? "");
    const payload = (env.payload as Record<string, unknown> | undefined) ?? {};

    if (kind === "user_prompt") {
      const text = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (text) out.push({ role: "user", content: text });
      continue;
    }
    if (kind === "assistant_message") {
      const contentVal =
        typeof payload.content === "string"
          ? payload.content
          : typeof env.content === "string"
          ? env.content
          : "";
      if (contentVal.trim()) out.push({ role: "assistant", content: contentVal });
      continue;
    }
    // EngineTurnComplete events from Pi-style implicit completion carry
    // the final assistant text under `assistantMessage` — surface those
    // too so resumed sessions see the assistant's last reply even when
    // no explicit assistant_message envelope was emitted. Dedup against
    // the previous assistant turn because the engine emits both for the
    // same completion.
    if (kind === "engine_turn_complete") {
      const text = typeof payload.assistantMessage === "string" ? payload.assistantMessage.trim() : "";
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && last.content === text) continue;
      out.push({ role: "assistant", content: text });
      continue;
    }
  }
  return out;
}