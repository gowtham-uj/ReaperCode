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
  return path.join(workspaceRoot, ".reaper", "sessions");
}

function journalPath(workspaceRoot: string, name: string): string {
  return path.join(sessionsDir(workspaceRoot), `${name}.jsonl`);
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
  await mkdir(sessionsDir(input.workspaceRoot), { recursive: true });
  const jp = journalPath(input.workspaceRoot, input.name);
  if (existsSync(jp)) {
    throw new Error(`Session "${input.name}" already exists.`);
  }
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
  const now = new Date().toISOString();
  const initial = input.title
    ? padToBytes(titleSlotLine(input.title, input.source ?? "auto", now).trimEnd(), TITLE_SLOT_BYTES)
    : "";
  const lines = [
    initial,
    `${JSON.stringify(header)}\n`,
  ];
  await writeFile(jp, lines.filter(Boolean).join("") + "\n", "utf8");
  return { header, journalPath: jp };
}

export function journalExists(workspaceRoot: string, name: string): boolean {
  return existsSync(journalPath(workspaceRoot, name));
}

/** Append a single entry to the journal. The parent must already exist
 *  (or be null for a root entry, which is reserved for the header). */
export async function appendEntry(
  workspaceRoot: string,
  name: string,
  entry: SessionEntry,
): Promise<void> {
  const jp = journalPath(workspaceRoot, name);
  if (!existsSync(jp)) {
    throw new Error(`Session "${name}" does not exist.`);
  }
  await appendFile(jp, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function setTitle(
  workspaceRoot: string,
  name: string,
  title: string,
  source: "auto" | "user" = "user",
): Promise<void> {
  const jp = journalPath(workspaceRoot, name);
  if (!existsSync(jp)) {
    throw new Error(`Session "${name}" does not exist.`);
  }
  const truncated = truncateForSlot(title, source, new Date().toISOString());
  const slot = padToBytes(titleSlotLine(truncated, source, new Date().toISOString()).trimEnd(), TITLE_SLOT_BYTES);
  const raw = await readFile(jp, "utf8");
  const firstNewline = raw.indexOf("\n");
  const rest = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
  // Atomic temp-write + rename. On EPERM (windows / locked file) we
  // leave a `.bak` for recovery. Mirrors OMP's recoverOrphanedBackups
  // pattern.
  const tmp = `${jp}.tmp`;
  const bak = `${jp}.${Date.now()}.bak`;
  await writeFile(tmp, slot + rest, "utf8");
  try {
    await rename(tmp, jp);
  } catch (err) {
    // Save as .bak so a future `recoverOrphanedBackups` can pick it up.
    try {
      await rename(tmp, bak);
    } catch {
      /* give up */
    }
    throw err;
  }
  // Also append a title_change entry for audit.
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
  const files = readdirSync(dir);
  let recovered = 0;
  // Group: base name -> .bak files
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const m = f.match(/^(.+?)\.(\d+)\.bak$/);
    if (!m) continue;
    const base = m[1]!;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(f);
  }
  for (const [base, baks] of byBase) {
    const primaryPath = path.join(dir, base);
    if (existsSync(primaryPath)) continue;
    // Sort by mtime descending, take the newest.
    baks.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
    const newest = baks[0]!;
    const from = path.join(dir, newest);
    const to = path.join(dir, base);
    try {
      // Use copy + unlink because we can't rename across the same path
      // if the target is a hardlink/symlink. On most systems rename
      // works; on some filesystems it doesn't.
      const data = readFileSync(from);
      writeFileSync(to, data);
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
  // Find the header line. It might be line 0 (no title slot) or line 1
  // (after a title slot). The header is the first line whose JSON.parse
  // yields `{type: "session"}`.
  let title: string | undefined;
  let titleSource: "auto" | "user" | undefined;
  let titleUpdatedAt: string | undefined;
  let header: SessionHeader | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; title?: string; source?: "auto" | "user"; updatedAt?: string };
    try {
      obj = JSON.parse(trimmed) as typeof obj;
    } catch {
      continue;
    }
    if (obj.type === TITLE_SLOT_TYPE && obj.title) {
      title = obj.title;
      titleSource = obj.source;
      titleUpdatedAt = obj.updatedAt;
      continue;
    }
    if (obj.type === "session") {
      header = obj as SessionHeader;
      break;
    }
  }
  if (!header) return null;
  // Override title with the slot's title if present.
  if (title) {
    header.title = title;
  }
  if (titleSource) {
    header.titleSource = titleSource;
  }
  return {
    header,
    ...(title ? { title } : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(titleUpdatedAt ? { titleUpdatedAt } : {}),
  };
}

export function readEntries(workspaceRoot: string, name: string, options: { maxRows?: number; fromTail?: boolean } = {}): SessionEntry[] {
  const jp = journalPath(workspaceRoot, name);
  if (!existsSync(jp)) return [];
  const raw = readFileSync(jp, "utf8");
  const lines = raw.split("\n");
  // Skip the slot (line 0) and header (line 1).
  const dataLines: string[] = [];
  let seenHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i === 0) continue; // slot
    if (!seenHeader) {
      // The header line may have padding if slot is empty; detect by JSON parse.
      try {
        const obj = JSON.parse(line.trim()) as { type?: string };
        if (obj.type === "session") {
          seenHeader = true;
          continue;
        }
      } catch {
        // skip
      }
    }
    if (line.trim()) dataLines.push(line);
  }
  let entries: SessionEntry[] = [];
  for (const line of dataLines) {
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // skip malformed
    }
  }
  if (options.fromTail) entries.reverse();
  if (options.maxRows) entries = entries.slice(0, options.maxRows);
  return entries;
}

/** The id of the last entry in the journal (the leaf of the main branch). */
export function lastEntryId(workspaceRoot: string, name: string): string | null {
  const entries = readEntries(workspaceRoot, name, { fromTail: true, maxRows: 1 });
  return entries[0]?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Active-branch rehydration
// ─────────────────────────────────────────────────────────────────────────

/** Walk the parent chain from the leaf to build the live conversation. */
export function buildActiveBranchMessages(workspaceRoot: string, name: string): SessionMessage[] {
  const entries = readEntries(workspaceRoot, name);
  if (entries.length === 0) return [];
  // Find leaf: the last entry whose type is "message" and isn't followed by a child.
  // Simpler: the last entry with parentId pointing into the chain. For now, take
  // the entry with the highest ts as the leaf, then walk parents.
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  // Leaf = entry with no children.
  const hasChild = new Set<string>();
  for (const e of entries) {
    if (e.parentId) hasChild.add(e.parentId);
  }
  let leaf: SessionEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!hasChild.has(entries[i]!.id)) {
      leaf = entries[i]!;
      break;
    }
  }
  if (!leaf) return [];
  // Walk parents.
  const chain: SessionEntry[] = [];
  let cur: SessionEntry | undefined = leaf;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  // A compaction entry with an inline summary replaces everything before
  // it (OMP semantics: summary + raw tail). Use the LAST such entry.
  let cutIdx = -1;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const e = chain[i]!;
    if (e.type === "compaction" && typeof (e as CompactionEntry).payload.summary === "string" && (e as CompactionEntry).payload.summary!.length > 0) {
      cutIdx = i;
      break;
    }
  }
  const tail = (cutIdx >= 0 ? chain.slice(cutIdx + 1) : chain)
    .filter((e): e is MessageEntry => e.type === "message")
    .map((e) => e.payload);
  if (cutIdx < 0) return tail;
  const summary = (chain[cutIdx] as CompactionEntry).payload.summary!;
  const anchor: SessionMessage = {
    role: "user",
    content:
      "# Prior session context (compacted)\n" +
      "The earlier conversation in this session was summarized to stay within the context budget. " +
      "Treat this summary as the authoritative record of everything before the turns that follow.\n\n" +
      summary,
  };
  return [anchor, ...tail];
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
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const out: SessionSummary[] = [];
  for (const f of files) {
    const name = f.slice(0, -".jsonl".length);
    try {
      const stat = statSync(path.join(dir, f));
      const headerRaw = readHeader(workspaceRoot, name);
      if (!headerRaw) continue;
      out.push({
        name,
        header: headerRaw.header,
        ...(headerRaw.title ? { title: headerRaw.title } : {}),
        ...(headerRaw.titleSource ? { titleSource: headerRaw.titleSource } : {}),
        status: deriveStatus(workspaceRoot, name),
        sizeBytes: stat.size,
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

/** Copy entries [0..fromEntryId] from `fromName` into a new session `name`. */
export async function forkSession(input: ForkInput): Promise<{ header: SessionHeader; journalPath: string }> {
  const fromEntries = readEntries(input.workspaceRoot, input.fromName);
  const fromHeader = readHeader(input.workspaceRoot, input.fromName);
  if (!fromHeader) {
    throw new Error(`Source session "${input.fromName}" not found.`);
  }
  // Find the cut point.
  const idx = fromEntries.findIndex((e) => e.id === input.fromEntryId);
  if (idx < 0) {
    throw new Error(`Entry ${input.fromEntryId} not found in ${input.fromName}.`);
  }
  const slice = fromEntries.slice(0, idx + 1);
  // Create new journal with the same header minus the id, plus a branch entry.
  const { header, journalPath } = await initJournal({
    name: input.name,
    workspaceRoot: input.workspaceRoot,
    cwd: fromHeader.header.cwd,
    ...(fromHeader.header.model ? { model: fromHeader.header.model } : {}),
    ...(fromHeader.header.provider ? { provider: fromHeader.header.provider } : {}),
    ...(fromHeader.title ? { title: fromHeader.title, source: fromHeader.titleSource ?? "user" } : {}),
  });
  // Append the copied entries.
  for (const e of slice) {
    await appendEntry(input.workspaceRoot, input.name, e);
  }
  // Mark the fork point.
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
