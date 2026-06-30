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

export function summarizeGitDiffState(state: GitDiffState): string {
  const filesChanged = state.status.entries.length;
  const cleanText = state.status.clean ? "clean" : `${filesChanged} changed file${filesChanged === 1 ? "" : "s"}`;
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
