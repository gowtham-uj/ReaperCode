import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface ReaperScratchpadPaths {
  /** `<workspace>/.reaper` */
  root: string;
  /** Root of per-session/run state: `.reaper/sessions`. */
  sessions: string;
  /**
   * Deprecated property name kept while callers migrate. It points at
   * `sessions`, not at `.reaper/logs`.
   *
   * Keeping the property avoids a flag-day refactor across logging code while
   * changing the folder a user sees on disk. New code should say `sessions`.
   */
  logs: string;
  /** Created by ArtifactStore on its first write. */
  artifacts: string;
  /** Created only when failure/verified lessons are persisted. */
  memory: string;
  /** Package-manager homes, created by the package manager that uses them. */
  dependencies: string;
  /** Package-manager caches, created by the package manager that uses them. */
  cache: string;
}

/**
 * The workspace-local state Reaper actually owns.
 *
 * ```text
 * .reaper/
 *   latest-run.json
 *   sessions/<id>/
 *     session.jsonl
 *     conversation.md
 *     reaper-audit.jsonl
 *     model-calls/
 *     artifacts/
 *   artifacts/          created only when ArtifactStore writes
 *   memory/             created only when recovery memory writes
 *   dependencies/       created only when a package manager uses its home
 *   cache/              created only when a package manager uses its cache
 * ```
 *
 * `code/` and `tmp/` are gone. An audit across `src/` found no reader or writer
 * for either one; they were empty directories created in every thread and
 * nothing more. The four optional roots above have real users, but those users
 * already call `mkdir` on first write or are package managers that create their
 * own directory. Creating them in advance made an untouched thread look busy
 * without storing any state.
 *
 * Existing workspaces may still have `.reaper/logs/<id>`. `getReaperLogDir`
 * reads that location when the new session directory does not exist, so old
 * threads continue to open. New runs always use `.reaper/sessions/<id>`.
 */
export function getReaperScratchpadPaths(workspaceRoot: string): ReaperScratchpadPaths {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  /*
   * Legacy scratchpad callers sometimes pass `<scratchpad>/code` as the
   * workspace. Keep resolving that to the parent scratchpad even though new
   * layouts no longer create a `code/` directory; this is path compatibility,
   * not a reason to recreate the folder.
   */
  const root =
    path.basename(resolvedWorkspace) === "code" && path.basename(path.dirname(resolvedWorkspace)) === "scratchpad"
      ? path.dirname(resolvedWorkspace)
      : path.join(resolvedWorkspace, ".reaper");
  const sessions = path.join(root, "sessions");
  return {
    root,
    sessions,
    // Compatibility property. It deliberately points to the new location.
    logs: sessions,
    artifacts: path.join(root, "artifacts"),
    memory: path.join(root, "memory"),
    dependencies: path.join(root, "dependencies"),
    cache: path.join(root, "cache"),
  };
}

/** The old physical location, used only when opening an existing thread. */
export function getLegacyReaperLogDir(workspaceRoot: string, id: string): string {
  return path.join(getLegacyReaperSessionRoot(workspaceRoot), id);
}

/**
 * The directory holding new session directories. Writers use this; readers that
 * need to see legacy threads as well should iterate `sessionsRoots` instead.
 */
export function getNewReaperSessionRoot(workspaceRoot: string): string {
  return getReaperScratchpadPaths(workspaceRoot).sessions;
}

/** `.reaper/logs`, the location builds before the rename wrote to. */
export function getLegacyReaperSessionRoot(workspaceRoot: string): string {
  return path.join(getReaperScratchpadPaths(workspaceRoot).root, "logs");
}

/**
 * Directory for one named session or anonymous run.
 *
 * A new path wins. If it does not exist and a legacy `.reaper/logs/<id>` does,
 * return the legacy path so a thread written by an older build remains readable
 * and any resumed writes stay beside its journal rather than splitting one run
 * across two directories.
 */
export function getReaperLogDir(workspaceRoot: string, id: string): string {
  const current = path.join(getReaperScratchpadPaths(workspaceRoot).sessions, id);
  if (existsSync(current)) return current;
  const legacy = getLegacyReaperLogDir(workspaceRoot, id);
  return existsSync(legacy) ? legacy : current;
}

/** New runs always use the new, self-describing location. */
export function getNewReaperSessionDir(workspaceRoot: string, id: string): string {
  return path.join(getReaperScratchpadPaths(workspaceRoot).sessions, id);
}

/**
 * Reserve the private state root and nothing else.
 *
 * This used to call `mkdir` for every value in `ReaperScratchpadPaths`, which
 * created seven directories on every thread. Six were empty in a real session.
 * Writers now create what they use. The root remains `0700` because it contains
 * transcripts, audit data, and provider-derived output.
 */
export async function ensureReaperScratchpad(workspaceRoot: string): Promise<ReaperScratchpadPaths> {
  const paths = getReaperScratchpadPaths(workspaceRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  return paths;
}
