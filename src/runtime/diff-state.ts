import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitStatusEntry {
  code: string;
  path: string;
  originalPath?: string;
}

export interface GitStatusState {
  baseRevision: string;
  clean: boolean;
  statusShort: string;
  entries: GitStatusEntry[];
}

export interface GitDiffState {
  baseRevision: string;
  status: GitStatusState;
  diffStat: string;
  diff: string;
  truncated: boolean;
}

export interface GitDiffOptions {
  staged?: boolean;
  path?: string;
  maxBytes?: number;
}

const DEFAULT_MAX_DIFF_BYTES = 64_000;

export async function getGitStatusState(workspaceRoot: string): Promise<GitStatusState> {
  const [baseRevision, statusShort] = await Promise.all([
    gitOutput(workspaceRoot, ["rev-parse", "HEAD"]).catch(() => "unavailable"),
    gitOutput(workspaceRoot, ["status", "--short", "--untracked-files=all"]),
  ]);
  const entries = parseGitStatusShort(statusShort);
  return {
    baseRevision,
    clean: entries.length === 0,
    statusShort,
    entries,
  };
}

export async function getGitDiffState(workspaceRoot: string, options: GitDiffOptions = {}): Promise<GitDiffState> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const pathArgs = options.path ? ["--", options.path] : [];
  const diffArgs = ["diff", "--binary", ...(options.staged ? ["--cached"] : []), ...pathArgs];
  const statArgs = ["diff", "--stat", ...(options.staged ? ["--cached"] : []), ...pathArgs];
  const [status, diffStat, rawDiff] = await Promise.all([
    getGitStatusState(workspaceRoot),
    gitOutput(workspaceRoot, statArgs),
    gitOutput(workspaceRoot, diffArgs),
  ]);
  const diffBytes = Buffer.byteLength(rawDiff, "utf8");
  const truncated = diffBytes > maxBytes;
  const diff = truncated ? rawDiff.slice(0, maxBytes) : rawDiff;
  return {
    baseRevision: status.baseRevision,
    status,
    diffStat,
    diff,
    truncated,
  };
}

export function parseGitStatusShort(statusShort: string): GitStatusEntry[] {
  return statusShort
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3);
      const renameParts = rawPath.split(" -> ");
      if (renameParts.length === 2 && renameParts[0] && renameParts[1]) {
        return { code, originalPath: renameParts[0], path: renameParts[1] };
      }
      return { code, path: rawPath };
    });
}

/**
 * The one-line summary above the diff.
 *
 * Two counts, not one, and the distinction is the fix for a misleading line.
 * `git diff` says nothing about untracked files — they have no committed
 * version to diff against — so a workspace holding eight new files that git has
 * never seen produced `diff: ""` and `diffStat: ""` beneath a header reading
 * "8 changed files". The reader concludes the diff was elided; the truth is
 * that there is no diff, because the files are additions the index does not
 * know about yet.
 *
 * So the tracked count comes from the diff itself, and untracked files are
 * reported separately as what they are. "3 changed files, 8 untracked" tells
 * the reader both what is in the diff below and what is not.
 */
export function summarizeGitDiffState(state: GitDiffState): string {
  const untracked = state.status.entries.filter((entry) => entry.code.includes("?")).length;
  const tracked = state.status.entries.length - untracked;

  const parts: string[] = [];
  if (tracked === 0 && untracked === 0) {
    parts.push("clean");
  } else {
    if (tracked > 0) parts.push(`${tracked} changed file${tracked === 1 ? "" : "s"}`);
    if (untracked > 0) parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"} (no diff until added)`);
    if (tracked === 0) parts.push("nothing tracked has changed");
  }
  const cleanText = parts.join(", ");
  const stat = state.diffStat.trim();
  return stat ? `${cleanText}\n${stat}` : cleanText;
}

async function gitOutput(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Reaper Tests",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "reaper-tests@example.com",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Reaper Tests",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "reaper-tests@example.com",
    },
    maxBuffer: 1024 * 1024 * 1024,
  });
  return String(stdout).trimEnd();
}
