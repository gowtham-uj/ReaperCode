/**
 * Phase-3 dispatch glue for viewer tools. The executor's typed
 * `switch (call.name)` is a discriminated union that's already at the TS
 * narrowing budget limit, so the viewer names are intercepted **before**
 * the switch and routed here. Each viewer branch performs its own
 * Zod validation, parses the path/args, and returns a `ToolResult`-shaped
 * envelope consistent with the rest of the executor.
 *
 * Real tool bodies land in Phase 3 along with the `FileViewerRegistry`
 * per-run instance.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FileEditArgsSchema,
  FileFindArgsSchema,
  FileScrollArgsSchema,
  FileViewArgsSchema,
  type LintVerdict,
} from "./types.js";
import { LinterRegistry } from "./linter-registry.js";
import {
  FileViewerRegistry,
  clampWindow,
  numberLines,
} from "./viewer-registry.js";

export interface ViewerDispatchContext {
  workspaceRoot: string;
  /** Per-run registry. Lives on `ToolExecutor` instance. */
  viewerRegistry: FileViewerRegistry;
  /** Per-run linter registry. Lives on `ToolExecutor` instance. */
  linterRegistry: LinterRegistry;
  /** Optional callbacks the executor can wire in (snapshotting, write counts, …) */
  onBeforeView?: (path: string) => Promise<void>;
  onBeforeEdit?: (path: string) => Promise<void>;
}

interface ToolCallLike {
  id: string;
  name: string;
  args: unknown;
}

interface ToolResultLike {
  ok: true | false;
  output: string;
  durationMs: number;
  error?: { code: string; message: string; details?: unknown };
}

function ok(output: unknown, durationMs = 0): ToolResultLike {
  return {
    ok: true,
    output: typeof output === "string" ? output : JSON.stringify(output),
    durationMs,
  };
}

function fail(code: string, message: string, details?: unknown): ToolResultLike {
  return {
    ok: false,
    output: "",
    durationMs: 0,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
}

async function sha256OfPath(absPath: string): Promise<{ sha: string; mtimeMs: number; totalLines: number; content: string } | null> {
  try {
    const [content, st] = await Promise.all([readFile(absPath, "utf8"), stat(absPath)]);
    const totalLines = content.length === 0 ? 0 : content.split("\n").length;
    const sha = createHash("sha256").update(content).digest("hex");
    return { sha, mtimeMs: Math.floor(st.mtimeMs), totalLines, content };
  } catch {
    return null;
  }
}

function normalizeWorkspacePath(workspaceRoot: string, p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (path.isAbsolute(p)) return null; // disallow absolute paths to escape the workspace
  const resolved = path.resolve(workspaceRoot, p);
  const wsWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (resolved !== workspaceRoot && !resolved.startsWith(wsWithSep)) return null;
  return resolved;
}

const DEFAULT_WINDOW = 50;

export async function dispatchViewerTool(
  call: ToolCallLike,
  ctx: ViewerDispatchContext,
): Promise<ToolResultLike> {
  const started = Date.now();
  switch (call.name) {
    case "file_view":
      return handleFileView(call, ctx, started);
    case "file_scroll":
      return handleFileScroll(call, ctx, started);
    case "file_find":
      return handleFileFind(call, ctx, started);
    case "file_edit":
      return handleFileEdit(call, ctx, started);
    default:
      return fail("unknown_viewer_tool", `viewer dispatcher received unexpected call name: ${call.name}`);
  }
}

// ============================================================================
// file_view
// ============================================================================

async function handleFileView(
  call: ToolCallLike,
  ctx: ViewerDispatchContext,
  started: number,
): Promise<ToolResultLike> {
  const parsed = FileViewArgsSchema.safeParse(call.args);
  if (!parsed.success) {
    return fail("invalid_argument", "file_view: invalid args", parsed.error.flatten());
  }
  const absPath = normalizeWorkspacePath(ctx.workspaceRoot, parsed.data.path);
  if (!absPath) {
    return fail("permission_denied", `file_view: path "${parsed.data.path}" is not within the workspace root`);
  }
  if (!existsSync(absPath)) {
    return fail("not_found", `file_view: file not found: ${absPath}`);
  }
  if (ctx.onBeforeView) await ctx.onBeforeView(absPath);

  const fileState = await sha256OfPath(absPath);
  if (!fileState) {
    return fail("io_error", `file_view: failed to read ${absPath}`);
  }

  const window = parsed.data.window ?? DEFAULT_WINDOW;
  const startLine = parsed.data.start_line ?? 1;
  const totalLines = fileState.totalLines;
  const clamped = clampWindow(startLine, window, totalLines);
  const lines = fileState.content.split("\n").slice(clamped.start - 1, clamped.end - 1);
  const numbered = numberLines(lines, clamped.start);

  ctx.viewerRegistry.readOrInit(absPath, totalLines, fileState.sha, fileState.mtimeMs, {
    startLine: clamped.start,
    window: clamped.end - clamped.start,
  });

  return ok(
    {
      kind: "file_view",
      path: absPath,
      startLine: clamped.start,
      endLine: clamped.end,
      totalLines,
      truncated: clamped.truncated,
      window: numbered,
    },
    Date.now() - started,
  );
}

// ============================================================================
// file_scroll
// ============================================================================

async function handleFileScroll(
  call: ToolCallLike,
  ctx: ViewerDispatchContext,
  started: number,
): Promise<ToolResultLike> {
  const parsed = FileScrollArgsSchema.safeParse(call.args);
  if (!parsed.success) {
    return fail("invalid_argument", "file_scroll: invalid args", parsed.error.flatten());
  }
  const absPath = normalizeWorkspacePath(ctx.workspaceRoot, parsed.data.path);
  if (!absPath) {
    return fail("permission_denied", `file_scroll: path "${parsed.data.path}" is not within the workspace root`);
  }
  if (!existsSync(absPath)) {
    return fail("not_found", `file_scroll: file not found: ${absPath}`);
  }
  if (ctx.onBeforeView) await ctx.onBeforeView(absPath);

  const fileState = await sha256OfPath(absPath);
  if (!fileState) return fail("io_error", `file_scroll: failed to read ${absPath}`);

  // Ensure the registry has an entry for this path before scrolling.
  ctx.viewerRegistry.readOrInit(
    absPath,
    fileState.totalLines,
    fileState.sha,
    fileState.mtimeMs,
  );
  const lines = parsed.data.lines ?? DEFAULT_WINDOW;
  const view = ctx.viewerRegistry.scroll(
    absPath,
    parsed.data.direction,
    lines,
    fileState.totalLines,
  );
  if (!view) {
    return fail("not_found", `file_scroll: no registered view for ${absPath}; call file_view first`);
  }
  const sliced = fileState.content
    .split("\n")
    .slice(view.startLine - 1, view.endLine - 1);
  const numbered = numberLines(sliced, view.startLine);
  return ok(
    {
      kind: "file_view",
      path: absPath,
      startLine: view.startLine,
      endLine: view.endLine,
      totalLines: view.totalLines,
      truncated: view.truncated,
      window: numbered,
    },
    Date.now() - started,
  );
}

// ============================================================================
// file_find
// ============================================================================

async function handleFileFind(
  call: ToolCallLike,
  ctx: ViewerDispatchContext,
  started: number,
): Promise<ToolResultLike> {
  const parsed = FileFindArgsSchema.safeParse(call.args);
  if (!parsed.success) {
    return fail("invalid_argument", "file_find: invalid args", parsed.error.flatten());
  }
  const absPath = normalizeWorkspacePath(ctx.workspaceRoot, parsed.data.path);
  if (!absPath) {
    return fail("permission_denied", `file_find: path "${parsed.data.path}" is not within the workspace root`);
  }
  if (!existsSync(absPath)) {
    return fail("not_found", `file_find: file not found: ${absPath}`);
  }
  if (ctx.onBeforeView) await ctx.onBeforeView(absPath);

  const fileState = await sha256OfPath(absPath);
  if (!fileState) return fail("io_error", `file_find: failed to read ${absPath}`);
  const lines = fileState.content.split("\n");

  // Ensure registered before .find() so the anchor survives.
  ctx.viewerRegistry.readOrInit(
    absPath,
    fileState.totalLines,
    fileState.sha,
    fileState.mtimeMs,
  );
  const r = ctx.viewerRegistry.find(absPath, parsed.data.pattern, lines);
  if (!r) return fail("not_found", `file_find: pattern "${parsed.data.pattern}" not found in ${absPath}`);

  const matched = lines.slice(r.view.startLine - 1, r.view.endLine - 1);
  const numbered = numberLines(matched, r.view.startLine);
  return ok(
    {
      kind: "file_find",
      path: absPath,
      startLine: r.view.startLine,
      endLine: r.view.endLine,
      matchedLine: r.matchedLine,
      matchCount: lines.filter((line) => line.includes(parsed.data.pattern)).length,
      window: numbered,
    },
    Date.now() - started,
  );
}

// ============================================================================
// file_edit (with linter dispatch + atomic rollback)
// ============================================================================

async function handleFileEdit(
  call: ToolCallLike,
  ctx: ViewerDispatchContext,
  started: number,
): Promise<ToolResultLike> {
  const parsed = FileEditArgsSchema.safeParse(call.args);
  if (!parsed.success) {
    return fail("invalid_argument", "file_edit: invalid args", parsed.error.flatten());
  }
  const absPath = normalizeWorkspacePath(ctx.workspaceRoot, parsed.data.path);
  if (!absPath) {
    return fail("permission_denied", `file_edit: path "${parsed.data.path}" is not within the workspace root`);
  }
  if (ctx.onBeforeEdit) await ctx.onBeforeEdit(absPath);

  let preContent: string | null = null;
  try {
    preContent = await readFile(absPath, "utf8");
  } catch {
    preContent = null;
  }
  if (preContent === null) {
    return fail("not_found", `file_edit: file not found or not readable: ${absPath}`);
  }

  const allLines = preContent.length === 0 ? [] : preContent.split("\n");
  const totalLines = allLines.length;
  const { start_line, end_line, new_content } = parsed.data;
  if (start_line < 1 || end_line > totalLines + 1) {
    return fail("invalid_argument", `file_edit: range ${start_line}..${end_line} exceeds the file's ${totalLines} lines`);
  }
  const replacementLines = new_content.length === 0 ? [] : new_content.split("\n");
  const nextLines = [
    ...allLines.slice(0, start_line - 1),
    ...replacementLines,
    ...allLines.slice(end_line),
  ];
  const postContent = nextLines.join("\n");

  // Lint check before persisting
  const extension = path.extname(absPath).toLowerCase();
  const lintResult = await ctx.linterRegistry.dispatch({
    workspaceRoot: ctx.workspaceRoot,
    absPath,
    content: postContent,
    extension,
    timeoutMs: undefined,
  });
  const verdict: LintVerdict = lintResult.verdict;

  if (!verdict.ok) {
    // Do not write to disk. The file is unchanged on purpose.
    return ok(
      {
        kind: "file_edit",
        path: absPath,
        startLine: start_line,
        endLine: end_line,
        totalLines,
        window: [],
        lintVerdict: verdict,
        rolledBack: true,
      },
      Date.now() - started,
    );
  }

  // Persist + read back to refresh registry
  await writeFile(absPath, postContent, "utf8");
  const postFileState = await sha256OfPath(absPath);
  if (postFileState) {
    ctx.viewerRegistry.noteEdit(
      absPath,
      postFileState.totalLines,
      postFileState.sha,
      postFileState.mtimeMs,
    );
  }

  const halfWindow = Math.floor(DEFAULT_WINDOW / 2);
  const postStart = Math.max(1, start_line - halfWindow);
  const postEnd = Math.min(postFileState?.totalLines ?? totalLines, postStart + DEFAULT_WINDOW - 1) + 1;
  const sliced = nextLines.slice(postStart - 1, postEnd - 1);
  const numbered = numberLines(sliced, postStart);
  return ok(
    {
      kind: "file_edit",
      path: absPath,
      startLine: postStart,
      endLine: postEnd,
      totalLines: postFileState?.totalLines ?? totalLines,
      window: numbered,
      lintVerdict: verdict,
    },
    Date.now() - started,
  );
}
