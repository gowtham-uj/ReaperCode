import { readdir } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath } from "../../policy/paths.js";
import { withFileErrors } from "./file-errors.js";

export async function listDirectoryTool(
  workspaceRoot: string,
  args: { path: string; includeHidden?: boolean },
) {
  const target = normalizeWorkspacePath(workspaceRoot, args.path);
  // Unlike `grep_search`, refusing a *file* here is right — a file has no
  // entries, and no reading of the request makes listing one meaningful. What
  // was wrong was the answer: a bare `ENOTDIR: not a directory, scandir '…'`
  // named no tool, no argument, and no alternative.
  const entries = await withFileErrors(
    { requestedPath: args.path, needs: "directory", instead: "`file_view` to read it" },
    () => readdir(target, { withFileTypes: true }),
  );

  return {
    path: target,
    entries: entries
      .filter((entry) => args.includeHidden || !entry.name.startsWith("."))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b)),
    absolutePath: path.resolve(target),
  };
}
