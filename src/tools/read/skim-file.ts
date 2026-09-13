import { readFile } from "node:fs/promises";

import { pruneWithSwePruner, type SwePrunerConfig } from "../../context/swe-pruner.js";
import { normalizeWorkspacePath } from "../../policy/paths.js";
import { withFileErrors } from "./file-errors.js";

export async function skimFileTool(
  workspaceRoot: string,
  args: { path: string; goalHint: string },
  prunerConfig: SwePrunerConfig,
) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  // Without this, a directory or a missing file surfaced as a bare
  // `EISDIR: illegal operation on a directory, read` — the same unreadable
  // errno that made a live model abandon `grep_search` mid-task.
  const content = await withFileErrors(
    { requestedPath: args.path, needs: "file", instead: "list_directory for a directory's contents" },
    () => readFile(filePath, "utf8"),
  );
  const result = await pruneWithSwePruner({
    config: prunerConfig,
    query: args.goalHint,
    code: content,
  });

  return {
    path: filePath,
    prunedContent: result.prunedCode,
    keptFrags: result.keptFrags,
    originTokenCount: result.originTokenCount,
    leftTokenCount: result.leftTokenCount,
    source: result.source,
  };
}
