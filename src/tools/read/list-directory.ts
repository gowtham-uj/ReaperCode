import { readdir } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath } from "../../policy/paths.js";

export async function listDirectoryTool(
  workspaceRoot: string,
  args: { path: string; includeHidden?: boolean },
) {
  const target = normalizeWorkspacePath(workspaceRoot, args.path);
  const entries = await readdir(target, { withFileTypes: true });

  return {
    path: target,
    entries: entries
      .filter((entry) => args.includeHidden || !entry.name.startsWith("."))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b)),
    absolutePath: path.resolve(target),
  };
}
