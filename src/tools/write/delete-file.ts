import { rm } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath } from "../../policy/paths.js";

const PROTECTED_BASENAMES = new Set([".git", ".reaper", ".gitignore"]);

/**
 * Reject a delete target before any filesystem mutation. Shared by the
 * direct-disk path (`deleteFileTool`) and the WAL-staged path in the
 * executor so both enforce identical boundary + protection rules.
 */
export function assertDeletablePath(workspaceRoot: string, filePath: string): void {
  const root = path.resolve(workspaceRoot);

  // Never let the model delete the workspace root itself — `rm(path, { recursive:
  // true })` with path === root wipes the entire workspace. Also protect the
  // repo metadata and Reaper's own state directories from a single call.
  if (filePath === root) {
    throw new Error("delete_file: refusing to delete the workspace root");
  }
  if (PROTECTED_BASENAMES.has(path.basename(filePath))) {
    throw new Error(`delete_file: refusing to delete protected path '${path.basename(filePath)}'`);
  }
}

export async function deleteFileTool(workspaceRoot: string, args: { path: string }) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  assertDeletablePath(workspaceRoot, filePath);

  await rm(filePath, { force: true, recursive: true });
  return { path: filePath, deleted: true };
}
