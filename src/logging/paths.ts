import path from "node:path";

import { getReaperLogDir, getReaperScratchpadPaths } from "../workspace/scratchpad.js";

/**
 * Resolve the directory that holds one session/run's logs.
 * When `id` is omitted, returns the shared `.reaper/logs` root (legacy/global).
 */
export function resolveLogRoot(workspaceRoot: string, id?: string): string {
  if (id) return getReaperLogDir(workspaceRoot, id);
  return getReaperScratchpadPaths(workspaceRoot).logs;
}

export function sessionJsonlPath(workspaceRoot: string, id: string): string {
  return path.join(getReaperLogDir(workspaceRoot, id), "session.jsonl");
}

export function conversationMdPath(workspaceRoot: string, id: string): string {
  return path.join(getReaperLogDir(workspaceRoot, id), "conversation.md");
}

export function modelCallsDir(workspaceRoot: string, id: string): string {
  return path.join(getReaperLogDir(workspaceRoot, id), "model-calls");
}
