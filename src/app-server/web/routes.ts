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
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

export interface BrowserScreenshot {
  contentType: string;
  bytes: Buffer;
}

/**
 * Serve a browser screenshot the agent captured. The path is untrusted client
 * input, so it gets the same sandbox as every other file read — and then two
 * extra constraints:
 *
 * - only `.png` (the one format `browser_control` writes), so this route cannot
 *   become a generic binary-file read with a spoofed content type;
 * - a byte cap, so a client cannot ask this route to stream an arbitrarily
 *   large blob that merely happens to live inside the workspace.
 */
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

export async function readBrowserScreenshot(root: string, requested: string): Promise<BrowserScreenshot> {
  const target = resolveInsideRoot(root, requested);
  if (!target.endsWith(".png")) throw new Error("Not a screenshot");
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Not a file");
  if (info.size > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");

  return { contentType: "image/png", bytes: await readFile(target) };
}

/**
 * Where an uploaded file may land: the thread's folder, never above it.
 *
 * The destination is a *relative* path, not a name, because a folder upload
 * recreates its directory structure and so names paths like
 * `project/lib/util.ts`. Two things therefore have to hold, and both are
 * checked here rather than by the caller: the path is relative (an absolute
 * one would be joined against the root and silently become something else),
 * and the resolved result is inside the root (`resolveInsideRoot` is what
 * makes `../../etc/passwd` a rejection rather than a write).
 */
export function resolveUploadTarget(root: string, relativePath: string): string {
  const requested = relativePath.trim();
  if (!requested) throw new PathEscapeError(relativePath);
  // A NUL byte truncates the path in the syscall below, so a name that looks
  // harmless to JavaScript can name a different file to the kernel.
  if (requested.includes("\0")) throw new PathEscapeError(relativePath);
  if (path.isAbsolute(requested)) throw new PathEscapeError(relativePath);
  // A bare `.` or `..` resolves to a directory, and a write there fails with
  // an errno that says nothing about the actual mistake.
  const segments = requested.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) throw new PathEscapeError(relativePath);
  const last = segments[segments.length - 1];
  if (last === "." || last === "..") throw new PathEscapeError(relativePath);
  return resolveInsideRoot(root, requested);
}

/**
 * Write one uploaded file into the thread's folder.
 *
 * `bytes` is a Buffer as the REST layer read it off the socket; this function
 * is the only place that decides whether it is allowed to touch disk. The
 * caller does no path work at all.
 */
export async function writeWorkspaceUpload(
  root: string,
  input: { path: string; bytes: Buffer },
): Promise<{ path: string; bytes: number }> {
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadTooLargeError(input.bytes.byteLength);
  const target = resolveUploadTarget(root, input.path);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.bytes);
  return {
    path: path.relative(path.resolve(root), target).split(path.sep).join("/"),
    bytes: input.bytes.byteLength,
  };
}

export class UploadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Upload is ${bytes} bytes`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * The upload cap.
 *
 * Deliberately a single whole-file write rather than a stream: an upload that
 * is refused must be refused *before* anything is on disk, and a partial write
 * left behind by a cap that trips mid-stream is a file the agent would happily
 * read as if it were complete.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Give a thread's folder a repo, if it is still empty enough to want one.
 *
 * This is what used to happen at thread creation, and moving it here is what
 * makes `git clone <url> .` work in a thread folder: git refuses to clone into
 * a directory that already holds a repository, so initializing eagerly made
 * the single most normal thing to do with an empty folder impossible.
 *
 * The condition is deliberately narrow — only a directory with no `HEAD` and
 * no entries of its own gets one. A folder holding a clone (or any project)
 * already has a repo, either its own or an ancestor's, and adding one would
 * be the confusion this is meant to prevent rather than a fix for it. A folder
 * with files but no repo is a deliberate "no git here" and is left alone.
 *
 * Best-effort throughout: a workspace that cannot be read, or a machine without
 * git, gets no repo and no error, because the Diff tab having nothing to show
 * is a far smaller problem than the workbench failing to load.
 */
async function ensureRepoForEmptyDirectory(root: string): Promise<void> {
  const hasRepo = await stat(path.join(root, ".git")).then(() => true).catch(() => false);
  if (hasRepo) return;
  const entries = await readdir(root).catch(() => undefined);
  if (!entries || entries.length > 0) return;
  await run("git", ["init", "--quiet"], { cwd: root }).catch(() => undefined);
}

export async function gitStatus(root: string): Promise<{ entries: Array<{ status: string; path: string }> }> {
  await ensureRepoForEmptyDirectory(root);
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

/**
 * The working-tree diff, including files git does not track yet.
 *
 * Plain `git diff` reports nothing for an untracked file, which makes it the
 * wrong tool here: in a thread's own fresh workspace *every* file the agent
 * writes is untracked, so the Diff tab would sit empty through an entire
 * session of real work. `--intent-to-add` registers untracked paths so they
 * diff as additions, without staging their contents — the index is left as the
 * user had it.
 *
 * Best-effort, like the rest of this surface: outside a repo, or with no git
 * available, the answer is an empty diff rather than an error.
 */
export async function gitDiff(root: string, requested?: string): Promise<{ diff: string }> {
  await ensureRepoForEmptyDirectory(root);
  // The path is resolved through the sandbox and passed as an argv element,
  // never interpolated into a shell string.
  const target = requested ? resolveInsideRoot(root, requested) : undefined;
  const options = { cwd: root, maxBuffer: 16 * 1024 * 1024 };

  // Scoped to `target` when there is one so this never touches paths outside
  // what was asked for.
  const intentToAdd = ["add", "--intent-to-add", "--", target ?? "."];
  await run("git", intentToAdd, options).catch(() => undefined);

  const args = ["diff", "--no-color"];
  if (target) args.push("--", target);
  try {
    const { stdout } = await run("git", args, options);
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
