import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionMessageRole = "user" | "assistant" | "tool" | "custom";

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type SessionEntry =
  | (SessionEntryBase & { type: "session"; version: 1; cwd: string })
  | (SessionEntryBase & { type: "message"; role: SessionMessageRole; content: unknown })
  | (SessionEntryBase & { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number })
  | (SessionEntryBase & { type: "branch_summary"; fromId: string; summary: string })
  | (SessionEntryBase & { type: "model_change"; provider: string; modelId: string });

export type SessionEntryInput =
  | ({ type: "session"; version: 1; cwd: string } & Partial<Pick<SessionEntryBase, "id" | "parentId" | "timestamp">>)
  | ({ type: "message"; role: SessionMessageRole; content: unknown } & Partial<Pick<SessionEntryBase, "id" | "parentId" | "timestamp">>)
  | ({ type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number } & Partial<Pick<SessionEntryBase, "id" | "parentId" | "timestamp">>)
  | ({ type: "branch_summary"; fromId: string; summary: string } & Partial<Pick<SessionEntryBase, "id" | "parentId" | "timestamp">>)
  | ({ type: "model_change"; provider: string; modelId: string } & Partial<Pick<SessionEntryBase, "id" | "parentId" | "timestamp">>);

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}

export interface SessionListEntry {
  path: string;
  id: string;
  cwd: string;
  modified: Date;
  messageCount: number;
}

export function createSessionEntry(input: SessionEntryInput): SessionEntry {
  const base = {
    id: input.id ?? randomUUID(),
    parentId: input.parentId ?? null,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  switch (input.type) {
    case "session":
      return { ...base, type: "session", version: 1, cwd: input.cwd };
    case "message":
      return { ...base, type: "message", role: input.role, content: input.content };
    case "compaction":
      return { ...base, type: "compaction", summary: input.summary, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore };
    case "branch_summary":
      return { ...base, type: "branch_summary", fromId: input.fromId, summary: input.summary };
    case "model_change":
      return { ...base, type: "model_change", provider: input.provider, modelId: input.modelId };
  }
}

export class ReaperSessionManager {
  static async create(options: { filePath: string; cwd: string }): Promise<ReaperSessionManager> {
    const root = createSessionEntry({ type: "session", version: 1, cwd: options.cwd });
    await mkdir(path.dirname(options.filePath), { recursive: true });
    await writeFile(options.filePath, `${JSON.stringify(root)}\n`, "utf8");
    return new ReaperSessionManager(options.filePath, [root], root.id);
  }

  static async open(filePath: string): Promise<ReaperSessionManager> {
    const entries = await readEntries(filePath);
    const root = entries.find((entry): entry is Extract<SessionEntry, { type: "session" }> => entry.type === "session");
    if (!root) throw new Error(`Session file has no root session entry: ${filePath}`);
    return new ReaperSessionManager(filePath, entries, entries.at(-1)?.id ?? root.id);
  }

  static async importJsonl(sourcePath: string, targetPath: string): Promise<ReaperSessionManager> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    return ReaperSessionManager.open(targetPath);
  }

  readonly entries: SessionEntry[];
  readonly root: Extract<SessionEntry, { type: "session" }>;
  private leafId: string;

  private constructor(private readonly filePath: string, entries: SessionEntry[], leafId: string) {
    this.entries = entries;
    const root = entries.find((entry): entry is Extract<SessionEntry, { type: "session" }> => entry.type === "session");
    if (!root) throw new Error("Session manager requires a session root");
    this.root = root;
    this.leafId = leafId;
  }

  async appendEntry(input: SessionEntryInput): Promise<SessionEntry> {
    const parentId = input.parentId !== undefined ? input.parentId : this.leafId;
    const entry = createSessionEntry({ ...input, parentId } as SessionEntryInput);
    await this.persist(entry);
    this.entries.push(entry);
    this.leafId = entry.id;
    return entry;
  }

  async appendMessage(input: { role: SessionMessageRole; content: unknown; parentId?: string | null }): Promise<SessionEntry> {
    return this.appendEntry({ type: "message", role: input.role, content: input.content, ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) });
  }

  async appendCompaction(input: { summary: string; firstKeptEntryId: string; tokensBefore: number; parentId?: string | null }): Promise<SessionEntry> {
    return this.appendEntry({ type: "compaction", summary: input.summary, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore, ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) });
  }

  async forkBefore(entryId: string, input: { summary: string }): Promise<SessionEntry> {
    const target = this.requireEntry(entryId);
    return this.appendEntry({ type: "branch_summary", fromId: entryId, summary: input.summary, parentId: target.parentId });
  }

  async forkAt(entryId: string, input: { summary: string }): Promise<SessionEntry> {
    this.requireEntry(entryId);
    return this.appendEntry({ type: "branch_summary", fromId: entryId, summary: input.summary, parentId: entryId });
  }

  buildSessionContext(leafId: string = this.leafId): SessionEntry[] {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const result: SessionEntry[] = [];
    let current: SessionEntry | undefined = byId.get(leafId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      result.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return result.reverse();
  }

  async exportJsonl(targetPath: string): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  }

  /** Move the leaf pointer to an earlier entry to start a new branch from it. */
  branch(branchFromId: string): void {
    this.requireEntry(branchFromId);
    this.leafId = branchFromId;
  }

  /** Reset the leaf pointer to the session root so the next append creates a fresh root child. */
  resetLeaf(): void {
    this.leafId = this.root.id;
  }

  /**
   * Branch with a `branch_summary` entry that captures the abandoned path.
   * The new summary is appended as a child of `branchFromId` (or, when null,
   * as a child of the session root), matching the reference semantics.
   */
  async branchWithSummary(branchFromId: string | null, summary: string): Promise<SessionEntry> {
    const resolved = branchFromId ?? this.root.id;
    if (branchFromId !== null) this.requireEntry(branchFromId);
    const previousLeaf = this.leafId;
    this.leafId = resolved;
    const entry = await this.appendEntry({
      type: "branch_summary",
      fromId: resolved,
      summary,
      parentId: previousLeaf,
    });
    return entry;
  }

  getLeafId(): string {
    return this.leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.entries.filter((entry) => entry.parentId === parentId);
  }

  /** Walks parent pointers from `fromId` (or the current leaf) back to the root, returning the path. */
  getBranch(fromId?: string): SessionEntry[] {
    const startId = fromId ?? this.leafId;
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const path: SessionEntry[] = [];
    let current = byId.get(startId);
    while (current) {
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path.reverse();
  }

  /**
   * Returns the full tree rooted at the session root. Orphans (entries whose
   * parent no longer exists) are also returned as roots, matching the
   * reference manager.
   */
  getTree(): SessionTreeNode[] {
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of this.entries) {
      nodeMap.set(entry.id, { entry, children: [] });
    }
    for (const entry of this.entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null) {
        roots.push(node);
        continue;
      }
      const parent = nodeMap.get(entry.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const byTime = (a: SessionTreeNode, b: SessionTreeNode) =>
      Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp);
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort(byTime);
      stack.push(...node.children);
    }
    return roots;
  }

  /**
   * Fork this session into a new JSONL file under `targetDir`. The new file
   * contains a fresh session header with the requested cwd and a copy of all
   * current entries, with parent IDs rewritten to point at the new root.
   * Reaper uses this for "fork from another project" flows.
   */
  async forkTo(targetDir: string, options: { cwd: string; id?: string }): Promise<ReaperSessionManager> {
    await mkdir(targetDir, { recursive: true });
    const newId = options.id ?? randomUUID();
    const newHeader = createSessionEntry({ id: newId, type: "session", version: 1, cwd: options.cwd });
    const fileTimestamp = newHeader.timestamp.replace(/[:.]/g, "-");
    const newFile = path.join(targetDir, `${fileTimestamp}_${newId}.jsonl`);
    await mkdir(path.dirname(newFile), { recursive: true });
    await writeFile(newFile, `${JSON.stringify(newHeader)}\n`, "utf8");
    const rootMapping = new Map<string, string>([[this.root.id, newId]]);
    for (const entry of this.entries) {
      if (entry.type === "session") continue;
      const parentId = entry.parentId && rootMapping.has(entry.parentId)
        ? rootMapping.get(entry.parentId)!
        : entry.parentId && entry.parentId === this.root.id
          ? newId
          : entry.parentId;
      const rewritten = { ...entry, parentId } as SessionEntry;
      await appendFile(newFile, `${JSON.stringify(rewritten)}\n`, "utf8");
    }
    return ReaperSessionManager.open(newFile);
  }

  private requireEntry(entryId: string): SessionEntry {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Session entry not found: ${entryId}`);
    return entry;
  }

  private async persist(entry: SessionEntry): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

async function readEntries(filePath: string): Promise<SessionEntry[]> {
  const raw = await readFile(filePath, "utf8");
  const entries: SessionEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isSessionEntry(parsed)) entries.push(parsed);
    } catch {
      // Skip malformed lines so a partially corrupted session can still be resumed.
    }
  }
  return entries;
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    (typeof record.parentId === "string" || record.parentId === null) &&
    typeof record.timestamp === "string" &&
    typeof record.type === "string";
}

/**
 * Fork a session from a source JSONL file into a new session under
 * `targetDir`. The new file contains a fresh session header with the
 * requested cwd and a copy of all source entries. Used by the "fork from
 * another project" flow.
 */
export async function forkSessionFromFile(
  sourcePath: string,
  targetDir: string,
  options: { cwd: string; id?: string },
): Promise<ReaperSessionManager> {
  const source = await ReaperSessionManager.open(sourcePath);
  return source.forkTo(targetDir, options);
}

/**
 * Continue the most recent session in `sessionDir`, or return undefined when
 * no JSONL files exist. Reaper uses this for "continue recent" flows.
 */
export async function continueRecentSession(
  sessionDir: string,
): Promise<ReaperSessionManager | undefined> {
  const files = await listSessionFiles(sessionDir);
  if (files.length === 0) return undefined;
  return ReaperSessionManager.open(files[0]!.path);
}

/**
 * List sessions under `sessionDir`, newest first. Each entry includes the
 * session id, cwd, message count, and last-modified timestamp.
 */
export async function listSessions(sessionDir: string): Promise<SessionListEntry[]> {
  const files = await listSessionFiles(sessionDir);
  const results: SessionListEntry[] = [];
  for (const file of files) {
    try {
      const manager = await ReaperSessionManager.open(file.path);
      const messages = manager.entries.filter((entry) => entry.type === "message").length;
      results.push({
        path: file.path,
        id: manager.root.id,
        cwd: manager.root.cwd,
        modified: file.modified,
        messageCount: messages,
      });
    } catch {
      // Skip unreadable or malformed session files; listing is best-effort.
    }
  }
  return results;
}

interface SessionFileInfo {
  path: string;
  modified: Date;
}

async function listSessionFiles(sessionDir: string): Promise<SessionFileInfo[]> {
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    const files: SessionFileInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const fullPath = path.join(sessionDir, entry.name);
      try {
        const stats = await stat(fullPath);
        files.push({ path: fullPath, modified: stats.mtime });
      } catch {
        // Skip unreadable files.
      }
    }
    files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return files;
  } catch {
    return [];
  }
}
