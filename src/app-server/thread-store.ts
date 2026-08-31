import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { buildActiveBranchMessages, isValidSessionName, journalExists, type SessionMessage } from "../context/session-journal.js";
import type { PermissionMode } from "../policy/classifier.js";

export const ThreadStatusSchema = z.enum(["idle", "running", "closed", "error"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const TurnStatusSchema = z.enum(["running", "completed", "aborted", "failed"]);
export type ManagedTurnStatus = z.infer<typeof TurnStatusSchema>;

const PermissionModeSchema = z.enum(["yolo", "accept_edits", "auto", "strict"]);

export const ThreadMetadataSchema = z.object({
  version: z.literal(1),
  threadId: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  sessionName: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  workspaceRoot: z.string().min(1),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema,
  title: z.string().max(500).optional(),
  status: ThreadStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastTurn: z.object({
    turnId: z.string().min(1),
    status: TurnStatusSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    assistantMessage: z.string().optional(),
    error: z.object({
      name: z.string(),
      message: z.string(),
    }).optional(),
  }).optional(),
});

export type ThreadMetadata = z.infer<typeof ThreadMetadataSchema>;

export interface CreateThreadMetadataInput {
  threadId?: string;
  sessionName?: string;
  workspaceRoot: string;
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
  title?: string;
}

export interface ThreadReadResult {
  metadata: ThreadMetadata;
  messages: SessionMessage[];
  journalExists: boolean;
}

/** Persists only non-secret thread identity and runtime choices. */
export class ThreadStore {
  readonly threadsDirectory: string;

  constructor(readonly dataRoot: string) {
    this.threadsDirectory = path.join(path.resolve(dataRoot), ".reaper", "app-server", "threads");
  }

  createMetadata(input: CreateThreadMetadataInput): ThreadMetadata {
    const threadId = input.threadId ?? randomUUID();
    const sessionName = input.sessionName ?? `app-${threadId}`;
    if (!isValidSessionName(threadId)) throw new Error(`Invalid thread ID: ${threadId}`);
    if (!isValidSessionName(sessionName)) throw new Error(`Invalid session name: ${sessionName}`);

    const now = new Date().toISOString();
    return ThreadMetadataSchema.parse({
      version: 1,
      threadId,
      sessionName,
      workspaceRoot: path.resolve(input.workspaceRoot),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      permissionMode: input.permissionMode ?? "accept_edits",
      ...(input.title ? { title: input.title } : {}),
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
  }

  async save(metadata: ThreadMetadata): Promise<ThreadMetadata> {
    const parsed = ThreadMetadataSchema.parse({
      ...metadata,
      workspaceRoot: path.resolve(metadata.workspaceRoot),
      updatedAt: new Date().toISOString(),
    });
    await mkdir(this.threadsDirectory, { recursive: true });
    const destination = this.metadataPath(parsed.threadId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return parsed;
  }

  async load(threadId: string): Promise<ThreadMetadata | undefined> {
    const filename = this.metadataPath(threadId);
    try {
      const raw = await readFile(filename, "utf8");
      return ThreadMetadataSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<ThreadMetadata[]> {
    let names: string[];
    try {
      names = await readdir(this.threadsDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const metadata = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const threadId = name.slice(0, -".json".length);
          try {
            return await this.load(threadId);
          } catch {
            return undefined;
          }
        }),
    );

    return metadata
      .filter((entry): entry is ThreadMetadata => Boolean(entry))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async read(threadId: string): Promise<ThreadReadResult | undefined> {
    const metadata = await this.load(threadId);
    if (!metadata) return undefined;
    const exists = journalExists(metadata.workspaceRoot, metadata.sessionName);
    return {
      metadata,
      messages: exists
        ? buildActiveBranchMessages(metadata.workspaceRoot, metadata.sessionName)
        : [],
      journalExists: exists,
    };
  }

  private metadataPath(threadId: string): string {
    if (!isValidSessionName(threadId)) throw new Error(`Invalid thread ID: ${threadId}`);
    return path.join(this.threadsDirectory, `${threadId}.json`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
