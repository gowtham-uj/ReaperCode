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
 * The journal is the thing being looked for, so the decision is made about the
 * journal, not about a directory. This used to return the new path whenever the
 * new *directory* existed — and the run boot reserves that directory before the
 * trajectory writer resolves its path, so a thread whose journal lived at the
 * legacy `.reaper/logs/<id>` was shadowed by an empty `.reaper/sessions/<id>`
 * the moment its first turn started. Every read then resolved to the empty
 * directory and the conversation looked gone: the model answered the next
 * prompt as if nothing had been said. The user's words for it were "why does it
 * need to create another session when rehydrating the old session".
 *
 * So preference follows `session.jsonl`: whichever location actually holds the
 * journal wins. Only when neither holds one (a genuinely new session) does the
 * order matter, and then the new location is preferred.
 */
export function getReaperLogDir(workspaceRoot: string, id: string): string {
  const current = path.join(getReaperScratchpadPaths(workspaceRoot).sessions, id);
  const legacy = getLegacyReaperLogDir(workspaceRoot, id);
  if (existsSync(path.join(current, "session.jsonl"))) return current;
  if (existsSync(path.join(legacy, "session.jsonl"))) return legacy;
  // No journal either side yet (a fresh session, or one that died before its
  // first write). Keep the reserved directory if it is there so a caller mid-run
  // stays consistent; otherwise fall back to legacy if that is what exists.
  if (existsSync(current)) return current;
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
