import path from "node:path";

import { createBranch, createWorktree, deleteBranch, removeWorktree } from "../workspace/git.js";

export interface SandboxHandle {
  branchName: string;
  worktreePath: string;
}

export async function createSandboxWorkspace(workspaceRoot: string, sessionId: string, subTaskId: string): Promise<SandboxHandle> {
  const branchName = `reaper/subtask/${sessionId}/${subTaskId}`;
  await createBranch(workspaceRoot, branchName);
  const worktreePath = await createWorktree(workspaceRoot, branchName);
  return { branchName, worktreePath: path.resolve(worktreePath) };
}

export async function cleanupSandboxWorkspace(workspaceRoot: string, handle: SandboxHandle): Promise<void> {
  await removeWorktree(workspaceRoot, handle.worktreePath);
  await deleteBranch(workspaceRoot, handle.branchName);
}
