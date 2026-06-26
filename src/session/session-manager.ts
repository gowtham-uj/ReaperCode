import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
