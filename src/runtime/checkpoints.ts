import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isMutatingTool } from "./tool-taxonomy.js";
import { getGitStatusState, parseGitStatusShort, type GitStatusEntry } from "./diff-state.js";
import type { ToolCall } from "../tools/types.js";
import { isGitRepository } from "../workspace/git.js";

const execFileAsync = promisify(execFile);

export interface Checkpoint {
  id: string;
  createdAt: string;
  baseRevision: string;
  dirtyFilesBefore: string[];
  reason: string;
  toolCallIds: string[];
  restoreAvailable: boolean;
}

export interface CreateCheckpointInput {
  workspaceRoot: string;
  reason: string;
  toolCallIds?: string[];
}

export interface RestoreCheckpointResult {
  checkpoint: Checkpoint;
  restored: boolean;
  statusAfterRestore: string;
}

export function batchNeedsMutationCheckpoint(toolCalls: Pick<ToolCall, "name">[]): boolean {
  return toolCalls.some((call) => isMutatingTool(call.name) && call.name !== "create_checkpoint" && call.name !== "restore_checkpoint");
}

export async function createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    id: createCheckpointId(),
    createdAt: new Date().toISOString(),
    baseRevision: "unavailable",
    dirtyFilesBefore: [],
    reason: input.reason,
    toolCallIds: input.toolCallIds ?? [],
    restoreAvailable: false,
  };

  if (await isGitRepository(input.workspaceRoot)) {
    const status = await getGitStatusState(input.workspaceRoot);
    checkpoint.baseRevision = status.baseRevision;
    checkpoint.dirtyFilesBefore = status.entries.map(entryToDirtyFile);
    checkpoint.restoreAvailable = status.baseRevision !== "unavailable";
  }

  const checkpointDir = getCheckpointDir(input.workspaceRoot, checkpoint.id);
  await mkdir(checkpointDir, { recursive: true });

  if (checkpoint.restoreAvailable) {
    try {
      await writeGitPatch(input.workspaceRoot, checkpointDir, "staged.patch", ["diff", "--cached", "--binary"]);
      await writeGitPatch(input.workspaceRoot, checkpointDir, "worktree.patch", ["diff", "--binary"]);
    } catch (error) {
      // Oversized parent repo or pathological diffs: keep a metadata-only checkpoint
      // so the engine can continue, but do not advertise it as restorable.
      checkpoint.restoreAvailable = false;
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(
        path.join(checkpointDir, "restore-skipped.txt"),
        `Checkpoint patch capture failed: ${message}\n`,
        "utf8",
      );
    }
  }

  await writeFile(path.join(checkpointDir, "metadata.json"), JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpoint;
}

export async function restoreCheckpoint(workspaceRoot: string, checkpointId: string): Promise<RestoreCheckpointResult> {
  const checkpoint = await readCheckpoint(workspaceRoot, checkpointId);
  if (!checkpoint.restoreAvailable || checkpoint.baseRevision === "unavailable") {
    throw new Error(`Checkpoint '${checkpointId}' is not restorable`);
  }

  const dirtyBefore = new Set(checkpoint.dirtyFilesBefore);
  await runGit(workspaceRoot, ["reset", "--hard", checkpoint.baseRevision]);
  await removeNewUntrackedFiles(workspaceRoot, dirtyBefore);
  await applyPatchIfPresent(workspaceRoot, getCheckpointPatchPath(workspaceRoot, checkpoint.id, "staged.patch"), ["apply", "--cached", "--binary"]);
  await applyPatchIfPresent(workspaceRoot, getCheckpointPatchPath(workspaceRoot, checkpoint.id, "worktree.patch"), ["apply", "--binary"]);
  const statusAfterRestore = (await getGitStatusState(workspaceRoot)).statusShort;

  return {
    checkpoint,
    restored: true,
    statusAfterRestore,
  };
}

export async function readCheckpoint(workspaceRoot: string, checkpointId: string): Promise<Checkpoint> {
  const raw = await readFile(path.join(getCheckpointDir(workspaceRoot, checkpointId), "metadata.json"), "utf8");
  return JSON.parse(raw) as Checkpoint;
}

export function getCheckpointDir(workspaceRoot: string, checkpointId: string): string {
  assertSafeCheckpointId(checkpointId);
  return path.join(workspaceRoot, ".reaper", "checkpoints", checkpointId);
}

function getCheckpointPatchPath(workspaceRoot: string, checkpointId: string, fileName: string): string {
  return path.join(getCheckpointDir(workspaceRoot, checkpointId), fileName);
}

function createCheckpointId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cp-${timestamp}-${randomUUID()}`;
}

function assertSafeCheckpointId(checkpointId: string): void {
  if (!/^cp-[A-Za-z0-9_-]+$/.test(checkpointId)) {
    throw new Error(`Invalid checkpoint id '${checkpointId}'`);
  }
}

function entryToDirtyFile(entry: GitStatusEntry): string {
  return entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path;
}

async function writeGitPatch(workspaceRoot: string, checkpointDir: string, fileName: string, args: string[]): Promise<void> {
  const patch = await runGit(workspaceRoot, args);
  await writeFile(path.join(checkpointDir, fileName), patch, "utf8");
}

async function applyPatchIfPresent(workspaceRoot: string, patchPath: string, args: string[]): Promise<void> {
  const patchStat = await stat(patchPath).catch(() => undefined);
  if (!patchStat || patchStat.size === 0) return;
  await runGit(workspaceRoot, [...args, patchPath]);
}

async function removeNewUntrackedFiles(workspaceRoot: string, dirtyFilesBefore: Set<string>): Promise<void> {
  const status = await runGit(workspaceRoot, ["status", "--short", "--untracked-files=all"]);
  const untracked = parseGitStatusShort(status).filter((entry) => entry.code === "??");
  for (const entry of untracked) {
    if (dirtyFilesBefore.has(entry.path) || entry.path.startsWith(".reaper/")) continue;
    await rm(path.join(workspaceRoot, entry.path), { force: true, recursive: true });
  }
}

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Reaper Tests",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "reaper-tests@example.com",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Reaper Tests",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "reaper-tests@example.com",
    },
    maxBuffer: 1024 * 1024 * 1024,
  });
  return String(stdout).trimEnd();
}
