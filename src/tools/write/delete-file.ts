import { rm } from "node:fs/promises";

import { normalizeWorkspacePath } from "../../policy/paths.js";

export async function deleteFileTool(workspaceRoot: string, args: { path: string }) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  await rm(filePath, { force: true, recursive: true });
  return { path: filePath, deleted: true };
}
