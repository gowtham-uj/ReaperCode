import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath } from "../../policy/paths.js";
import { ToolArgumentError } from "../read/file-errors.js";

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
    throw new ToolArgumentError("delete_file: refusing to delete the workspace root", "invalid_argument");
  }
  if (PROTECTED_BASENAMES.has(path.basename(filePath))) {
    throw new ToolArgumentError(
      `delete_file: refusing to delete protected path '${path.basename(filePath)}'`,
      "invalid_argument",
    );
  }
}

/**
 * Refuse to delete a directory.
 *
 * The tool is named `delete_file` and described as "Delete a file". Nothing in
 * its schema or description offers to remove a tree, so a model that passes a
 * directory is making a mistake — not asking for recursive deletion it has no
 * way to know is available.
 *
 * Left unguarded, `rm(filePath, { recursive: true })` removed the whole tree
 * and returned `{ deleted: true }`. A workspace containing `src/a.ts` and
 * `src/nested/b.ts` lost both files, and the nested file was never named in the
 * call and never mentioned in the result. **The largest irreversible action in
 * the tool set had the weakest guard of any of them**, and its success reply
 * read exactly like a single-file delete.
 */
export async function assertDeletableTarget(workspaceRoot: string, filePath: string, requestedPath: string): Promise<void> {
  assertDeletablePath(workspaceRoot, filePath);

  const info = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    // `force: true` makes deleting an absent path a no-op, which is the
    // behaviour callers already rely on. Anything else is real.
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;

  if (info.isDirectory()) {
    throw new ToolArgumentError(
      `delete_file: '${requestedPath}' is a directory. This tool deletes a single file. ` +
        "Use list_directory to see what it contains, then delete the files you actually mean to remove.",
      "invalid_argument",
    );
  }
}

export async function deleteFileTool(workspaceRoot: string, args: { path: string }) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  await assertDeletableTarget(workspaceRoot, filePath, args.path);

  // `recursive` is kept even though a directory can no longer reach this point:
  // the guard is a `stat` before the call, and a path that becomes a directory
  // in between must not turn `rm` into a throw. The refusal above is what
  // protects the model; this is belt-and-braces for the race.
  await rm(filePath, { force: true, recursive: true });
  return { path: filePath, deleted: true };
}
