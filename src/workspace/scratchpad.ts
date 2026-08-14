import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface ReaperScratchpadPaths {
  root: string;
  code: string;
  /** Root of all per-id session/run directories: `.reaper/logs`. */
  logs: string;
  artifacts: string;
  memory: string;
  dependencies: string;
  cache: string;
  tmp: string;
}

/**
 * Root layout:
 *   .reaper/
 *     logs/<id>/          unified per-session or per-run directory
 *       session.jsonl
 *       conversation.md
 *       evidence-manifest.json
 *       session.index.json
 *       journal.jsonl
 *       reaper-audit.jsonl
 *       langfuse-events.jsonl
 *       model-calls/
 *       artifacts/
 *       result.json, manifest.json, ...
 *
 * `id` is either a user-provided --session name or a generated run id.
 * Structure is identical either way.
 */
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
  };
}

/** Unified directory for one named session or one anonymous exec run. */
export function getReaperLogDir(workspaceRoot: string, id: string): string {
  return path.join(getReaperScratchpadPaths(workspaceRoot).logs, id);
}

export async function ensureReaperScratchpad(workspaceRoot: string): Promise<ReaperScratchpadPaths> {
  const paths = getReaperScratchpadPaths(workspaceRoot);
  await Promise.all(Object.values(paths).map((dir) => mkdir(dir, { recursive: true })));
  return paths;
}
