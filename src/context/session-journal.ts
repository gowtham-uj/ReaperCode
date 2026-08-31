/**
 * context/session-journal.ts — append-only session journal.
 *
 * Inspired by oh-my-pi's SessionManager: a single JSONL file per session
 * containing one header line followed by typed entries. Entries form a tree
 * via (id, parentId), with a mutable leaf pointer that selects which
 * branch is "active" for future appends. This is the foundation for
 * branches, forks, and resumable cross-day sessions.
 *
 *   <session-name>.jsonl
 *     [title-slot: 1 line, fixed-width, fast listing]
 *     [header: 1 line, SessionHeader with id, cwd, createdAt, model, provider]
 *     [entries: 1+ lines, each typed SessionEntry]
 *     [each entry: id, parentId, type, ts, payload]
 *
 * Entry types (mirroring OMP):
 *   - init          : session created
 *   - message       : user, assistant, or tool message
 *   - compaction    : full-summarization cut (with summary + saved tokens)
 *   - model_change  : which model is active (informs restart)
 *   - mode_change   : which mode (plan, build, etc.)
 *   - label         : user tag (debug, blocked, todo, etc.)
 *   - title_change  : user renamed the session
 *   - branch        : mark a fork point
 *
 * The journal is the single source of truth: a session is its journal.
 * On resume, we read the header, restore the leaf, walk the tree to
 * build the live conversation, and re-apply any pending state changes.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../logging/redaction.js";
import {
  buildCompactionCheckpoint,
  COMPACTION_CHECKPOINT_MESSAGE_NAME,
  COMPACTION_SUMMARY_MESSAGE_NAME,
  COMPACTION_SUMMARY_PREFIX,
  renderCompactionCheckpoint,
  type CompactionCheckpoint,
} from "./compaction-checkpoint.js";

// ─────────────────────────────────────────────────────────────────────────
// Entry types
// ─────────────────────────────────────────────────────────────────────────

export type SessionEntryType =
  | "init"
  | "message"
  | "compaction"
  | "model_change"
  | "mode_change"
  | "label"
  | "title_change"
  | "branch"
  | "savings"
  | "tool_call"
  | "tool_result"
  | "checkpoint";

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** Tool call id (when role is tool or when this is an assistant message with tool_calls). */
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; args: unknown }>;
  name?: string;
  is_error?: boolean;
  /** Wall-clock timestamp (ms since epoch) for time-based compaction. */
  ts?: number;
  /** Set by shake so we know the result was already compacted. */
  shaken?: boolean;
}

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  type: SessionEntryType;
  ts: string;
  /** Human-readable note surfaced in the journal viewer. */
  note?: string;
}

export interface InitEntry extends SessionEntryBase {
  type: "init";
  payload: { cwd: string; model?: string; provider?: string; initialPrompt?: string };
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  payload: SessionMessage;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  payload: {
    preChars: number;
    postChars: number;
    savedChars: number;
    /** Number of tool results shaken. */
    resultsShaken: number;
    /** Path to the persisted summary file (relative to journal). */
    summaryPath?: string;
    /**
     * Inline summary text (full_summary write-back). When present,
     * rehydration starts from this entry: the summary REPLACES every
     * message before it, and only messages after it are kept raw.
     */
    summary?: string;
    /** Optional query that triggered this compaction. */
    query?: string;
    /** Structured continuity state paired with the canonical summary. */
    checkpoint?: CompactionCheckpoint;
  };
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  payload: { from?: string; to: string; provider?: string };
}

export interface ModeChangeEntry extends SessionEntryBase {
  type: "mode_change";
  payload: { from?: string; to: string; data?: Record<string, unknown> };
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  payload: { label: string; color?: string };
}

export interface TitleChangeEntry extends SessionEntryBase {
  type: "title_change";
  payload: { title: string; source: "auto" | "user" };
}

export interface BranchEntry extends SessionEntryBase {
  type: "branch";
  payload: { from: string; reason?: string };
}

export interface SavingsEntry extends SessionEntryBase {
  type: "savings";
  payload: {
    kind: "shake" | "time_microcompact" | "full_summary" | "spillover";
    cleared?: number;
    savedChars: number;
    contextWindow?: number;
    ratio?: number;
  };
}

export interface ToolCallEntry extends SessionEntryBase {
  type: "tool_call";
  payload: { toolName: string; args: unknown; callId: string };
}

export interface ToolResultEntry extends SessionEntryBase {
  type: "tool_result";
  payload: { callId: string; toolName: string; ok: boolean; content: string };
}

export interface CheckpointEntry extends SessionEntryBase {
  type: "checkpoint";
  payload: { label: string; runId?: string };
}

export type SessionEntry =
  | InitEntry
  | MessageEntry
  | CompactionEntry
  | ModelChangeEntry
  | ModeChangeEntry
  | LabelEntry
  | TitleChangeEntry
  | BranchEntry
  | SavingsEntry
  | ToolCallEntry
  | ToolResultEntry
  | CheckpointEntry;

// ─────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────

export interface SessionHeader {
  type: "session";
  id: string;
  v: number;
  name: string;
  cwd: string;
  createdAt: string;
  model?: string;
  provider?: string;
  title?: string;
  titleSource?: "auto" | "user";
  /** Schema version for the journal format. */
  formatVersion: 1;
}

export const CURRENT_FORMAT_VERSION = 1;
export const TITLE_SLOT_BYTES = 1024;
export const TITLE_SLOT_TYPE = "title_slot";

// ─────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────

function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".reaper", "logs");
}

function journalPath(workspaceRoot: string, name: string): string {
  return path.join(sessionsDir(workspaceRoot), name, "session.jsonl");
}

function titleSlotLine(title: string, source: "auto" | "user" | undefined, updatedAt: string): string {
  const slot = source
    ? { type: TITLE_SLOT_TYPE, v: 1, title, source, updatedAt }
    : { type: TITLE_SLOT_TYPE, v: 1, title, updatedAt };
  return `${JSON.stringify(slot)}\n`;
}

/** Truncate title so the slot line fits in TITLE_SLOT_BYTES. */
function truncateForSlot(title: string, source: "auto" | "user" | undefined, updatedAt: string): string {
  const line = titleSlotLine(title, source, updatedAt);
  if (Buffer.byteLength(line, "utf8") <= TITLE_SLOT_BYTES) return title;
  // Binary-search the longest prefix that fits.
  let lo = 0;
  let hi = title.length;
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cand = title.slice(0, mid);
    const l = titleSlotLine(cand, source, updatedAt);
    if (Buffer.byteLength(l, "utf8") <= TITLE_SLOT_BYTES) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function padToBytes(s: string, target: number): string {
  const line = `${s}\n`;
  const have = Buffer.byteLength(line, "utf8");
  if (have >= target) return line;
  return line + " ".repeat(target - have);
}

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;
export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface JournalInit {
  name: string;
  workspaceRoot: string;
  cwd: string;
  initialPrompt?: string;
  model?: string;
  provider?: string;
  title?: string;
  source?: "auto" | "user";
}

export async function initJournal(input: JournalInit): Promise<{ header: SessionHeader; journalPath: string }> {
  if (!isValidSessionName(input.name)) {
    throw new Error(`Invalid session name: ${input.name}`);
  }
  const jp = journalPath(input.workspaceRoot, input.name);
  await mkdir(path.dirname(jp), { recursive: true });
  // Pi-style: session.jsonl header is written on the first real event by
  // SessionLogWriter. init only reserves the directory.
  const header: SessionHeader = {
    type: "session",
    id: randomUUID(),
    v: CURRENT_FORMAT_VERSION,
    name: input.name,
    cwd: input.cwd,
    createdAt: new Date().toISOString(),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.title
      ? { title: input.title, titleSource: input.source ?? "auto" }
      : {}),
    formatVersion: CURRENT_FORMAT_VERSION,
  };
  return { header, journalPath: jp };
}

export function journalExists(workspaceRoot: string, name: string): boolean {
  // Directory reserved by initJournal, or an existing session.jsonl.
  const dir = path.join(sessionsDir(workspaceRoot), name);
  return existsSync(dir) || existsSync(journalPath(workspaceRoot, name));
}

/** Append a legacy typed entry row into session.jsonl (tests / compaction write-back). */
export async function appendEntry(
  workspaceRoot: string,
  name: string,
  entry: SessionEntry,
): Promise<void> {
  const jp = journalPath(workspaceRoot, name);
  await mkdir(path.dirname(jp), { recursive: true });
  const safeEntry = redactSecrets(entry) as SessionEntry;
  await appendFile(jp, `${JSON.stringify(safeEntry)}\n`, "utf8");
}

export async function setTitle(
  workspaceRoot: string,
  name: string,
  title: string,
  source: "auto" | "user" = "user",
): Promise<void> {
  const jp = journalPath(workspaceRoot, name);
  await mkdir(path.dirname(jp), { recursive: true });
  const truncated = truncateForSlot(title, source, new Date().toISOString());
  // Title-change is an audit entry in the session tree. No separate title slot.
  await appendEntry(workspaceRoot, name, {
    id: randomUUID(),
    parentId: lastEntryId(workspaceRoot, name),
    type: "title_change",
    ts: new Date().toISOString(),
    payload: { title: truncated, source },
  });
}

/**
 * Scan for orphaned `.bak` files (left by failed atomic rewrites) and
 * promote the newest one to the journal file if the primary is missing.
 * Returns the number of recoveries performed.
 *
 * Mirrors OMP's `recoverOrphanedBackups`. Idempotent: only acts when the
 * primary is absent.
 */
export function recoverOrphanedBackups(workspaceRoot: string): number {
  const dir = sessionsDir(workspaceRoot);
  if (!existsSync(dir)) return 0;
  let recovered = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(dir, entry.name);
    let files: string[] = [];
    try {
      files = readdirSync(sessionDir);
    } catch {
      continue;
    }
    const baks = files.filter((f) => /^session\.jsonl\.\d+\.bak$/.test(f) || /^journal\.jsonl\.\d+\.bak$/.test(f));
    if (baks.length === 0) continue;
    const primaryPath = path.join(sessionDir, "session.jsonl");
    if (existsSync(primaryPath)) continue;
    baks.sort((a, b) => statSync(path.join(sessionDir, b)).mtimeMs - statSync(path.join(sessionDir, a)).mtimeMs);
    const newest = baks[0]!;
    const from = path.join(sessionDir, newest);
    try {
      const data = readFileSync(from);
      writeFileSync(primaryPath, data);
      unlinkSync(from);
      recovered += 1;
    } catch {
      /* leave the bak for next time */
    }
  }
  return recovered;
}

// ─────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────

export interface JournalHeader {
  header: SessionHeader;
  title?: string;
  titleSource?: "auto" | "user";
  titleUpdatedAt?: string;
}

export function readHeader(workspaceRoot: string, name: string): JournalHeader | null {
  const jp = journalPath(workspaceRoot, name);
  if (!existsSync(jp)) return null;
  const raw = readFileSync(jp, "utf8");
  return parseHeader(raw);
}

export function parseHeader(raw: string): JournalHeader | null {
  if (!raw) return null;
  const lines = raw.split("\n");
  let title: string | undefined;
  let titleSource: "auto" | "user" | undefined;
  let titleUpdatedAt: string | undefined;
  let header: SessionHeader | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === TITLE_SLOT_TYPE && typeof obj.title === "string") {
      title = obj.title;
      titleSource = obj.source === "user" || obj.source === "auto" ? obj.source : undefined;
      titleUpdatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : undefined;
      continue;
    }
    if (obj.type === "session") {
      header = obj as unknown as SessionHeader;
      continue;
    }
    if (obj.kind === "header") {
      const metadata = obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as Record<string, unknown>) : undefined;
      header = {
        type: "session",
        id: String(obj.id ?? randomUUID()),
        v: CURRENT_FORMAT_VERSION,
        name: nameFromMetadata(metadata) ?? "session",
        cwd: String(obj.cwd ?? ""),
        createdAt: typeof obj.createdAt === "number" ? new Date(obj.createdAt).toISOString() : new Date().toISOString(),
        formatVersion: CURRENT_FORMAT_VERSION,
      };
      continue;
    }
    if (obj.type === "title_change" && obj.payload && typeof obj.payload === "object") {
      const payload = obj.payload as { title?: string; source?: "auto" | "user" };
      if (typeof payload.title === "string") {
        title = payload.title;
        titleSource = payload.source;
        titleUpdatedAt = typeof obj.ts === "string" ? obj.ts : undefined;
      }
    }
  }
  if (!header && !title) return null;
  if (!header) {
    header = {
      type: "session",
      id: randomUUID(),
      v: CURRENT_FORMAT_VERSION,
      name: "session",
      cwd: "",
      createdAt: new Date().toISOString(),
      formatVersion: CURRENT_FORMAT_VERSION,
    };
  }
  if (title) header.title = title;
  if (titleSource) header.titleSource = titleSource;
  return {
    header,
    ...(title ? { title } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(titleUpdatedAt ? { titleUpdatedAt } : {}),
  };
}

function nameFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const sessionId = metadata.sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

export function readEntries(workspaceRoot: string, name: string, options: { maxRows?: number; fromTail?: boolean } = {}): SessionEntry[] {
  const jp = journalPath(workspaceRoot, name);
  if (!existsSync(jp)) return [];
  const raw = readFileSync(jp, "utf8");
  const entries: SessionEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.kind === "entry" && obj.type === "message" && obj.message && typeof obj.message === "object") {
      const message = obj.message as SessionMessage;
      entries.push({
        id: String(obj.id ?? randomUUID()),
        parentId: typeof obj.parentId === "string" ? obj.parentId : null,
        type: "message",
        ts: typeof obj.timestamp === "number" ? new Date(obj.timestamp).toISOString() : new Date().toISOString(),
        payload: message,
      });
      continue;
    }
    if (obj.kind === "entry" && obj.type === "compaction") {
      const details = obj.details && typeof obj.details === "object" ? (obj.details as Record<string, unknown>) : {};
      const summary =
        typeof obj.summary === "string"
          ? obj.summary
          : typeof details.summary === "string"
            ? details.summary
            : undefined;
      const payload: CompactionEntry["payload"] = {
        preChars: Number(details.preChars ?? details.summary_chars ?? 0) || 0,
        postChars: Number(details.postChars ?? 0) || 0,
        savedChars: Number(details.savedChars ?? details.saved_chars ?? 0) || 0,
        resultsShaken: Number(details.resultsShaken ?? 0) || 0,
      };
      if (summary) payload.summary = summary;
      if (details.checkpoint) {
        payload.checkpoint = details.checkpoint as NonNullable<CompactionEntry["payload"]["checkpoint"]>;
      }
      entries.push({
        id: String(obj.id ?? randomUUID()),
        parentId: typeof obj.parentId === "string" ? obj.parentId : null,
        type: "compaction",
        ts: typeof obj.timestamp === "number" ? new Date(obj.timestamp).toISOString() : new Date().toISOString(),
        payload,
      });
      continue;
    }
    if (typeof obj.type === "string" && obj.id && !obj.kind) {
      try {
        entries.push(obj as unknown as SessionEntry);
      } catch {
        /* skip */
      }
    }
  }
  if (options.fromTail) entries.reverse();
  if (options.maxRows) return entries.slice(0, options.maxRows);
  return entries;
}

/** The id of the last message/compaction entry in the session tree. */
export function lastEntryId(workspaceRoot: string, name: string): string | null {
  const entries = readEntries(workspaceRoot, name, { fromTail: true, maxRows: 1 });
  return entries[0]?.id ?? null;
}

/**
 * @deprecated Message tree is written via TrajectoryLogger → session.jsonl.
 * Kept as a no-op-compatible helper for older call sites during migration.
 */
export async function appendLiveMessage(
  _workspaceRoot: string,
  _name: string,
  _message: SessionMessage,
  parentId?: string | null,
): Promise<string> {
  return parentId ?? randomUUID();
}

export async function tryAppendLiveMessage(
  _workspaceRoot: string,
  _name: string | undefined,
  _message: SessionMessage,
  parentId?: string | null,
): Promise<string | null | undefined> {
  return parentId;
}

// ─────────────────────────────────────────────────────────────────────────
// Active-branch rehydration
// ─────────────────────────────────────────────────────────────────────────

/** Walk the parent chain from the leaf to build the live conversation. */
export function buildActiveBranchMessages(workspaceRoot: string, name: string): SessionMessage[] {
  const entries = readEntries(workspaceRoot, name);
  if (entries.length === 0) return [];
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  const hasChild = new Set<string>();
  for (const e of entries) {
    if (e.parentId) hasChild.add(e.parentId);
  }
  // The active tip is the newest message in the ancestry of the LAST
  // written entry — NOT the deepest tree leaf. After a fork, tree-depth
  // scanning can land on a sibling branch's leaf while the active work is
  // the branch whose entries were appended most recently. Following the
  // parent chain from the newest entry resolves the fork to the branch
  // that actually received the latest writes.
  let leaf: SessionEntry | undefined;
  let cursor: SessionEntry | undefined = entries[entries.length - 1];
  while (cursor) {
    if (cursor.type === "message") {
      leaf = cursor;
      break;
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  if (!leaf) {
    // Newest-entry ancestry contained no message (e.g. journal ends at a
    // compaction/savings row with no parent). Fall back to the last
    // message leaf so internal custom rows don't become the tip.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const candidate = entries[i]!;
      if (candidate.type === "message" && !hasChild.has(candidate.id)) {
        leaf = candidate;
        break;
      }
    }
  }
  if (!leaf) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (!hasChild.has(entries[i]!.id)) {
        leaf = entries[i]!;
        break;
      }
    }
  }
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let cur: SessionEntry | undefined = leaf;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  let cutIdx = -1;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const e = chain[i]!;
    if (e.type === "compaction" && typeof (e as CompactionEntry).payload.summary === "string" && (e as CompactionEntry).payload.summary!.length > 0) {
      cutIdx = i;
      break;
    }
  }
  const isInternalNotice = (message: SessionMessage): boolean => {
    const content = typeof message.content === "string" ? message.content : "";
    return content.startsWith("[session-resume]") || content.startsWith("[resume]") || content.startsWith("[summary-applied]");
  };
  const tail = (cutIdx >= 0 ? chain.slice(cutIdx + 1) : chain)
    .filter((e): e is MessageEntry => e.type === "message")
    .map((e) => e.payload)
    .filter((message) => !isInternalNotice(message));
  if (cutIdx < 0) return tail;
  const compaction = chain[cutIdx] as CompactionEntry;
  const summary = compaction.payload.summary!;
  const sourceMessages = chain
    .slice(0, cutIdx)
    .filter((entry): entry is MessageEntry => entry.type === "message")
    .map((entry) => entry.payload);
  const checkpoint =
    compaction.payload.checkpoint ??
    buildCompactionCheckpoint(summary, sourceMessages, { maxFiles: 20 });
  const boundary: SessionMessage = {
    role: "user",
    content:
      "# Prior session context (compacted)\n" +
      "The earlier conversation in this session was summarized to stay within the context budget. " +
      "The checkpoint and canonical summary below replace every earlier turn.",
  };
  const checkpointMessage: SessionMessage = {
    role: "user",
    name: COMPACTION_CHECKPOINT_MESSAGE_NAME,
    content: renderCompactionCheckpoint(checkpoint),
  };
  const summaryMessage: SessionMessage = {
    role: "user",
    name: COMPACTION_SUMMARY_MESSAGE_NAME,
    content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}`,
  };
  return [boundary, checkpointMessage, summaryMessage, ...tail];
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle status
// ─────────────────────────────────────────────────────────────────────────

export type LifecycleStatus =
  | "complete"
  | "interrupted"
  | "aborted"
  | "errored"
  | "pending"
  | "unknown";

export function deriveStatus(workspaceRoot: string, name: string): LifecycleStatus {
  const entries = readEntries(workspaceRoot, name, { fromTail: true, maxRows: 1 });
  const last = entries[0];
  if (!last) return "unknown";
  switch (last.type) {
    case "message": {
      const m = (last as MessageEntry).payload;
      if (m.role === "user") return "pending";
      if (m.role === "tool") return "interrupted"; // tool result without follow-up
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        return "interrupted"; // assistant planned calls but no result yet
      }
      return "complete";
    }
    case "savings":
    case "compaction":
    case "tool_call":
    case "tool_result":
    case "model_change":
    case "mode_change":
    case "label":
    case "title_change":
    case "branch":
    case "init":
    case "checkpoint":
      return "complete";
    default:
      return "unknown";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────

export interface SessionSummary {
  name: string;
  header: SessionHeader;
  title?: string;
  titleSource?: "auto" | "user";
  status: LifecycleStatus;
  sizeBytes: number;
  modified: string;
  entryCount: number;
}

export function listJournals(workspaceRoot: string): SessionSummary[] {
  const dir = sessionsDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => isValidSessionName(name) && (existsSync(journalPath(workspaceRoot, name)) || existsSync(path.join(dir, name))));
  const out: SessionSummary[] = [];
  for (const name of names) {
    try {
      const jp = journalPath(workspaceRoot, name);
      const statPath = existsSync(jp) ? jp : path.join(dir, name);
      const stat = statSync(statPath);
      const headerRaw = readHeader(workspaceRoot, name);
      const header: SessionHeader = headerRaw?.header ?? {
        type: "session",
        id: name,
        v: CURRENT_FORMAT_VERSION,
        name,
        cwd: workspaceRoot,
        createdAt: stat.mtime.toISOString(),
        formatVersion: CURRENT_FORMAT_VERSION,
      };
      out.push({
        name,
        header,
        ...(headerRaw?.title ? { title: headerRaw.title } : header.title ? { title: header.title } : {}),
        ...(headerRaw?.titleSource ? { titleSource: headerRaw.titleSource } : {}),
        status: deriveStatus(workspaceRoot, name),
        sizeBytes: stat.isFile() ? stat.size : 0,
        modified: stat.mtime.toISOString(),
        entryCount: readEntries(workspaceRoot, name).length,
      });
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out;
}
// ─────────────────────────────────────────────────────────────────────────
// Fork
// ─────────────────────────────────────────────────────────────────────────

export interface ForkInput {
  name: string;          // new session name
  workspaceRoot: string;
  fromName: string;      // source session
  fromEntryId: string;   // copy entries up to and including this id
  reason?: string;
}

export async function forkSession(input: ForkInput): Promise<{ header: SessionHeader; journalPath: string }> {
  const fromEntries = readEntries(input.workspaceRoot, input.fromName);
  if (!journalExists(input.workspaceRoot, input.fromName) && fromEntries.length === 0) {
    throw new Error(`Source session "${input.fromName}" not found.`);
  }
  const fromHeader = readHeader(input.workspaceRoot, input.fromName);
  const idx = fromEntries.findIndex((e) => e.id === input.fromEntryId);
  if (idx < 0) {
    throw new Error(`Entry ${input.fromEntryId} not found in ${input.fromName}.`);
  }
  const slice = fromEntries.slice(0, idx + 1);
  const { header, journalPath } = await initJournal({
    name: input.name,
    workspaceRoot: input.workspaceRoot,
    cwd: fromHeader?.header.cwd ?? input.workspaceRoot,
    ...(fromHeader?.header.model ? { model: fromHeader.header.model } : {}),
    ...(fromHeader?.header.provider ? { provider: fromHeader.header.provider } : {}),
    ...(fromHeader?.title ? { title: fromHeader.title, source: fromHeader.titleSource ?? "user" } : {}),
  });
  for (const e of slice) {
    await appendEntry(input.workspaceRoot, input.name, e);
  }
  await appendEntry(input.workspaceRoot, input.name, {
    id: randomUUID(),
    parentId: slice[slice.length - 1]!.id,
    type: "branch",
    ts: new Date().toISOString(),
    payload: { from: input.fromEntryId, ...(input.reason ? { reason: input.reason } : {}) },
  });
  return { header, journalPath };
}

// ─────────────────────────────────────────────────────────────────────────
// Savings journal (cross-session)
// ─────────────────────────────────────────────────────────────────────────

function savingsJournalPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".reaper", "compaction-savings.jsonl");
}

export interface SavingsRecord {
  ts: number;
  session: string;
  kind: "shake" | "time_microcompact" | "full_summary" | "spillover";
  cleared?: number;
  savedChars: number;
  contextWindow?: number;
  ratio?: number;
}

export async function recordCompactionSavings(workspaceRoot: string, rec: SavingsRecord): Promise<void> {
  const dir = path.join(workspaceRoot, ".reaper");
  await mkdir(dir, { recursive: true });
  await appendFile(savingsJournalPath(workspaceRoot), `${JSON.stringify(rec)}\n`, "utf8");
}

export function readSavingsJournal(workspaceRoot: string, options: { sinceMs?: number; session?: string; maxRows?: number } = {}): SavingsRecord[] {
  const p = savingsJournalPath(workspaceRoot);
  if (!existsSync(p)) return [];
  const out: SavingsRecord[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SavingsRecord;
      if (options.sinceMs && r.ts < options.sinceMs) continue;
      if (options.session && r.session !== options.session) continue;
      out.push(r);
    } catch {
      // skip
    }
  }
  if (options.maxRows) return out.slice(0, options.maxRows);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Identity-keyed dedup (mirrors OMP turn-persistence.ts)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stable per-message dedup key. OMP uses identity (timestamp +
 * provider/model/responseId) rather than content-hash, so retries and
 * re-runs of the same logical message don't collide.
 */
export function sessionMessagePersistenceKey(message: {
  role: string;
  timestamp?: number | string;
  tool_call_id?: string;
  tool_calls?: Array<{ name: string }>;
}): string | undefined {
  const ts = typeof message.timestamp === "number"
    ? message.timestamp
    : message.timestamp
      ? new Date(message.timestamp).getTime()
      : Date.now();
  switch (message.role) {
    case "assistant": {
      const name = message.tool_calls?.[0]?.name ?? "";
      return `assistant:${ts}:${name}`;
    }
    case "tool":
    case "tool_result":
      return `tool:${ts}:${message.tool_call_id ?? ""}`;
    case "user":
    case "system":
      return `${message.role}:${ts}`;
    default:
      return undefined;
  }
}

/**
 * Plan which turns should be persisted. Skips turns whose key is
 * already in `persistedKeys`. Detects out-of-order writes (a later key
 * is already persisted but an earlier one is not) so we don't lose
 * data.
 */
export function planTurnPersistence(
  turnKeys: ReadonlyArray<string | undefined>,
  persistedKeys: ReadonlySet<string>,
): { kind: "ok"; toPersist: number[] } | { kind: "out-of-order"; messageIndex: number } {
  const toPersist: number[] = [];
  for (let i = 0; i < turnKeys.length; i += 1) {
    const key = turnKeys[i];
    if (key === undefined) continue;
    if (persistedKeys.has(key)) continue;
    for (let later = i + 1; later < turnKeys.length; later += 1) {
      const laterKey = turnKeys[later];
      if (laterKey !== undefined && persistedKeys.has(laterKey)) {
        return { kind: "out-of-order", messageIndex: i };
      }
    }
    toPersist.push(i);
  }
  return { kind: "ok", toPersist };
}

// ─────────────────────────────────────────────────────────────────────────
// Signed-block guard for persistence (mirrors OMP session-persistence.ts)
// ─────────────────────────────────────────────────────────────────────────

/**
 * True if the entry contains a provider signature, encrypted reasoning,
 * or other block that must NOT be truncated. Mirrors OMP's
 * `truncateForPersistence` signed-block detection.
 */
export function isSignedBlock(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const p = entry.payload as unknown as Record<string, unknown>;
  if (typeof p !== "object" || p === null) return false;
  if (p["type"] === "thinking" && typeof p["thinkingSignature"] === "string" && p["thinkingSignature"]) return true;
  if (p["type"] === "text" && typeof p["textSignature"] === "string" && p["textSignature"]) return true;
  if (p["type"] === "toolCall" && typeof p["thoughtSignature"] === "string" && p["thoughtSignature"]) return true;
  if (p["type"] === "redactedThinking" && typeof p["data"] === "string" && p["data"]) return true;
  if (p["type"] === "reasoning" && typeof p["encrypted_content"] === "string" && p["encrypted_content"]) return true;
  return false;
}

export function aggregateSavings(records: SavingsRecord[]): {
  totalSavedChars: number;
  byKind: Record<string, number>;
  bySession: Record<string, number>;
} {
  let total = 0;
  const byKind: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  for (const r of records) {
    total += r.savedChars;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.savedChars;
    bySession[r.session] = (bySession[r.session] ?? 0) + r.savedChars;
  }
  return { totalSavedChars: total, byKind, bySession };
}
