/**
 * Read-only REST surface: file tree, file contents, git status/diff, config.
 *
 * These are stateless filesystem and git reads, so they run here rather than
 * as new app-server RPCs — they work with no active thread and need no
 * projection state.
 *
 * Every path is sandboxed to the workspace root. The check resolves first and
 * compares against the root *with a trailing separator*, so a sibling
 * directory whose name merely starts with the root's name ("/work-evil" vs
 * "/work") is rejected rather than accepted by a bare `startsWith`.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** `execFile`, not `exec` — arguments are argv elements, so a path containing
 *  shell metacharacters is data and can never become a command. */
const run = promisify(execFile);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path is outside the workspace root: ${requested}`);
    this.name = "PathEscapeError";
  }
}

/** Resolve a client-supplied path inside `root`, or throw. */
export function resolveInsideRoot(root: string, requested: string): string {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, requested);
  if (candidate !== absoluteRoot && !candidate.startsWith(absoluteRoot + path.sep)) {
    throw new PathEscapeError(requested);
  }
  return candidate;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

export async function listDirectory(root: string, requested: string): Promise<TreeEntry[]> {
  const target = resolveInsideRoot(root, requested || ".");
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: path.relative(path.resolve(root), path.join(target, entry.name)),
      type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    }))
    .sort((left, right) =>
      left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === "directory" ? -1 : 1,
    );
}

export interface FileContents {
  path: string;
  contents: string;
  truncated: boolean;
  bytes: number;
}

export async function readWorkspaceFile(root: string, requested: string): Promise<FileContents> {
  const target = resolveInsideRoot(root, requested);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Not a file");

  const handle = await readFile(target);
  const truncated = handle.byteLength > MAX_FILE_BYTES;
  return {
    path: requested,
    contents: (truncated ? handle.subarray(0, MAX_FILE_BYTES) : handle).toString("utf8"),
    truncated,
    bytes: handle.byteLength,
  };
}

export async function gitStatus(root: string): Promise<{ entries: Array<{ status: string; path: string }> }> {
  try {
    const { stdout } = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
    const entries = stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
    return { entries };
  } catch {
    return { entries: [] }; // Not a git repo, or git is unavailable.
  }
}

export async function gitDiff(root: string, requested?: string): Promise<{ diff: string }> {
  // The path is resolved through the sandbox and passed as an argv element,
  // never interpolated into a shell string.
  const args = ["diff", "--no-color"];
  if (requested) args.push("--", resolveInsideRoot(root, requested));
  try {
    const { stdout } = await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return { diff: stdout };
  } catch {
    return { diff: "" };
  }
}

/**
 * Config exposed to the browser, built by **allowlist**.
 *
 * A denylist would leak any secret-bearing field added later; this fails
 * closed instead — a new field is invisible until someone adds it here on
 * purpose.
 */
const CONFIG_ALLOWLIST = [
  "defaultProvider",
  "defaultModel",
  "permissionMode",
  "maxConcurrentTurns",
] as const;

export function redactConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of CONFIG_ALLOWLIST) {
    if (raw[key] !== undefined) safe[key] = raw[key];
  }
  return safe;
}
