import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface ReaperScratchpadPaths {
  root: string;
  code: string;
  logs: string;
  artifacts: string;
  memory: string;
  dependencies: string;
  cache: string;
  tmp: string;
  runs: string;
}

export function getReaperScratchpadPaths(workspaceRoot: string): ReaperScratchpadPaths {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const root =
    path.basename(resolvedWorkspace) === "code" && path.basename(path.dirname(resolvedWorkspace)) === "scratchpad"
      ? path.dirname(resolvedWorkspace)
      : path.join(resolvedWorkspace, ".reaper");
  return {
    root,
    code: path.join(root, "code"),
    logs: path.join(root, "logs"),
    artifacts: path.join(root, "artifacts"),
    memory: path.join(root, "memory"),
    dependencies: path.join(root, "dependencies"),
    cache: path.join(root, "cache"),
    tmp: path.join(root, "tmp"),
    runs: path.join(root, "runs"),
  };
}

export async function ensureReaperScratchpad(workspaceRoot: string): Promise<ReaperScratchpadPaths> {
  const paths = getReaperScratchpadPaths(workspaceRoot);
  await Promise.all(Object.values(paths).map((dir) => mkdir(dir, { recursive: true })));
  return paths;
}
