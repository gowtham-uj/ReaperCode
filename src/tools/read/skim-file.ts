import { readFile } from "node:fs/promises";

import { pruneWithSwePruner, type SwePrunerConfig } from "../../context/swe-pruner.js";
import { normalizeWorkspacePath } from "../../policy/paths.js";

export async function skimFileTool(
  workspaceRoot: string,
  args: { path: string; goalHint: string },
  prunerConfig: SwePrunerConfig,
) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  const content = await readFile(filePath, "utf8");
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
