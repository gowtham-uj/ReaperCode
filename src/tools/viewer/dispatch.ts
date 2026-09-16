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
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath as normalizePolicyPath, PathPolicyError } from "../../policy/paths.js";
import {
  FileEditArgsSchema,
  FileFindArgsSchema,
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
  /**
   * Staged (write-ahead-log) view of the workspace. When the executor runs
   * with a recovery session, `write_file`/`edit_file` stage content in the
   * WAL rather than writing it to disk, so a viewer that reads the
   * filesystem directly would report a just-written file as not found and
   * an edited file with pre-edit content.
   *
   * `readStaged` returns the staged content, `null` when the path is
   * staged for deletion, and `undefined` when nothing is staged for it
   * (read from disk as usual). `writeStaged`, when present, replaces the
   * viewer's own disk write so `file_edit` participates in the same
   * atomic flush/rollback as every other mutation.
   */
  readStaged?: (absPath: string) => Promise<string | null | undefined>;
  writeStaged?: (absPath: string, content: string) => Promise<void>;
}

interface ToolCallLike {
  id: string;
  name: string;
  args: unknown;
}

interface ToolResultLike {
  ok: true | false;
  /*
   * Carried as-is, not stringified.
   *
   * This was `string`, and `ok()` paid for it with a `JSON.stringify`, which
   * made these three tools the only ones in the registry whose result reaches
   * the model as JSON *text* rather than as a value. Everywhere else — `bash`,
   * `grep_search`, `glob`, `git_status`, `inspect_environment` — the caller
   * gets the object. The cost only became visible with Code Mode, where the
   * difference is not "extra quoting in a transcript" but a broken script:
   * `const { window } = await tools.file_view({ path })` destructures a
   * *string*, so `window` is `undefined` and the line throws — the exact
   * JSON.parse ceremony Code Mode exists to remove.
   *
   * The type is `unknown` rather than a viewer-shaped interface because that is
   * what `ToolResult.output` already is and what every consumer already
   * handles: `renderToolResultForModel`, the compaction renderers, the session
   * formatter and the engine all branch on `typeof output === "string"` and
   * stringify the rest. Widening this narrows nothing downstream.
   */
  output: unknown;
  durationMs: number;
  error?: { code: string; message: string; details?: unknown };
}

function ok(output: unknown, durationMs = 0): ToolResultLike {
  return {
    ok: true,
    output,
    durationMs,
  };
}

function fail(code: string, message: string, details?: unknown): ToolResultLike {
  return {
    ok: false,
    /*
     * `undefined`, matching every other tool's failure shape — a failed call
     * carries its reason in `error`, and `""` was a third spelling for "no
     * output" that only these three tools used.
     */
    output: undefined,
    durationMs: 0,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
}

function countMatches(lines: string[], pattern: string, caseInsensitive: boolean): number {
  const needle = caseInsensitive ? pattern.toLocaleLowerCase() : pattern;
  return lines.filter((line) => {
    const hay = caseInsensitive ? line.toLocaleLowerCase() : line;
    return hay.includes(needle);
  }).length;
}

interface FileState {
  sha: string;
  mtimeMs: number;
  totalLines: number;
  content: string;
}

function fileStateFromContent(content: string, mtimeMs: number): FileState {
  return {
    sha: createHash("sha256").update(content).digest("hex"),
    mtimeMs,
    totalLines: content.length === 0 ? 0 : content.split("\n").length,
    content,
  };
}

async function sha256OfPath(absPath: string): Promise<FileState | null> {
  try {
    const [content, st] = await Promise.all([readFile(absPath, "utf8"), stat(absPath)]);
    return fileStateFromContent(content, Math.floor(st.mtimeMs));
  } catch {
    return null;
  }
}

/**
 * Read a file the way every viewer handler should: staged content first,
 * disk as the fallback. Returns null when the file is absent from both
 * (or staged for deletion).
 */
async function readViewerFile(absPath: string, ctx: ViewerDispatchContext): Promise<FileState | null> {
  if (ctx.readStaged) {
    const staged = await ctx.readStaged(absPath);
    if (staged === null) return null; // staged for deletion
    // Staged content has no disk mtime; 0 is a stable sentinel that keeps
    // the viewer registry's freshness comparison self-consistent.
    if (staged !== undefined) return fileStateFromContent(staged, 0);
  }
  return sha256OfPath(absPath);
}

function normalizeWorkspacePath(workspaceRoot: string, p: string): string | null {
  if (!p || typeof p !== "string") return null;
  try {
    return normalizePolicyPath(workspaceRoot, p);
  } catch {
    return null;
  }
}

const DEFAULT_WINDOW = 50;

/**
 * Locate every place `block` occurs in `lines`, as 1-indexed start lines.
 * Stops after the second hit — the caller only distinguishes none / one / many.
 */
function findBlockOccurrences(lines: string[], block: string[]): number[] {
  if (block.length === 0 || block.length > lines.length) return [];
  const hits: number[] = [];
  const first = block[0];
  for (let i = 0; i + block.length <= lines.length; i += 1) {
    if (lines[i] !== first) continue;
    let matched = true;
    for (let j = 1; j < block.length; j += 1) {
      if (lines[i + j] !== block[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      hits.push(i + 1);
      if (hits.length > 1) return hits;
    }
  }
  return hits;
}

/**
 * Resolve the line range an edit should actually replace.
 *
 * Without `expected_content` the model's line numbers are taken on faith, which
 * is how a chain of edits ends up splicing into the wrong block: every earlier
 * edit shifts the file under the line numbers the model read. When the anchor
 * is supplied we verify it, relocate to the unique match if the file moved, and
 * refuse rather than corrupt when the anchor is gone or ambiguous.
 */
function resolveEditRange(
  allLines: string[],
  startLine: number,
  endLine: number,
  expected: string | undefined,
): { start: number; end: number; relocatedFrom?: { startLine: number; endLine: number } } | { error: string } {
  if (expected === undefined) return { start: startLine, end: endLine };
  const expectedLines = expected.length === 0 ? [] : expected.split("\n");
  const actualLines = allLines.slice(startLine - 1, endLine);
  if (actualLines.join("\n") === expectedLines.join("\n")) {
    return { start: startLine, end: endLine };
  }
  const hits = findBlockOccurrences(allLines, expectedLines);
  if (hits.length === 1) {
    const start = hits[0]!;
    return {
      start,
      end: start + expectedLines.length - 1,
      relocatedFrom: { startLine, endLine },
    };
  }
  const actualPreview = numberLines(actualLines, startLine).join("\n");
  if (hits.length === 0) {
    return {
      error:
        `file_edit: expected_content does not match lines ${startLine}..${endLine}, and no other location in the file matches it either. ` +
        `Nothing was written. The file currently reads:\n${actualPreview}\n` +
        `Re-read the file and retry with the text that is actually there.`,
    };
  }
  return {
    error:
      `file_edit: expected_content does not match lines ${startLine}..${endLine} and occurs in more than one place, so the target is ambiguous. ` +
      `Nothing was written. The file currently reads:\n${actualPreview}\n` +
      `Widen expected_content with surrounding lines so it identifies exactly one location.`,
  };
}

export async function dispatchViewerTool(
  call: ToolCallLike,
  ctx: ViewerDispatchContext,
): Promise<ToolResultLike> {
  const started = Date.now();
  switch (call.name) {
    case "file_view":
      return handleFileView(call, ctx, started);
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
  if (ctx.onBeforeView) await ctx.onBeforeView(absPath);

  const fileState = await readViewerFile(absPath, ctx);
  if (!fileState) {
    return fail("not_found", `file_view: file not found: ${absPath}`);
  }

  const window = parsed.data.window ?? DEFAULT_WINDOW;
  const totalLines = fileState.totalLines;
  const prior = ctx.viewerRegistry.get(absPath);

  // A `file_view` with no `start_line` always recomputes from line 1, so a
  // model that re-issues the same call on an unchanged file receives the same
  // page forever and can loop on it indefinitely. Detect the repeat: advance
  // past the window already shown, and say so, rather than serving page 1 again.
  const isRepeat =
    parsed.data.start_line === undefined &&
    prior !== undefined &&
    prior.sha256 === fileState.sha &&
    prior.mtimeMs === fileState.mtimeMs;
  const repeatCount = isRepeat ? (prior.repeatCount ?? 0) + 1 : 0;
  const autoAdvance = isRepeat && prior.endLine <= totalLines;

  const startLine = autoAdvance ? prior.endLine : (parsed.data.start_line ?? 1);
  const clamped = clampWindow(startLine, window, totalLines);
  const lines = fileState.content.split("\n").slice(clamped.start - 1, clamped.end - 1);
  const numbered = numberLines(lines, clamped.start);

  let note: string | undefined;
  if (autoAdvance) {
    note =
      `You already read lines ${prior.startLine}..${prior.endLine - 1} of this file and it has not changed, ` +
      `so this call advanced to the next window instead of repeating it. ` +
      (clamped.truncated
        ? `There is still more below line ${clamped.end - 1}; pass start_line explicitly to continue.`
        : `This is the end of the file.`);
  } else if (isRepeat) {
    note =
      `This is a repeat of a window you have already read and the file has not changed — you have now reached the end of it. ` +
      `Re-reading will not return anything new; use file_find to jump to a specific symbol, or act on what you have.`;
  }

  ctx.viewerRegistry.set({
    path: absPath,
    anchorLine: clamped.start,
    startLine: clamped.start,
    endLine: clamped.end,
    totalLines,
    sha256: fileState.sha,
    mtimeMs: fileState.mtimeMs,
    repeatCount,
  });

  return ok(
    {
      kind: "file_view",
      path: absPath,
      startLine: clamped.start,
      endLine: clamped.end,
      totalLines,
      sha256: fileState.sha,
      mtimeMs: fileState.mtimeMs,
      truncated: clamped.truncated,
      window: numbered,
      ...(note ? { note } : {}),
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
  if (ctx.onBeforeView) await ctx.onBeforeView(absPath);

  const fileState = await readViewerFile(absPath, ctx);
  if (!fileState) return fail("not_found", `file_find: file not found: ${absPath}`);
  const lines = fileState.content.split("\n");

  // Ensure registered before .find() so the anchor survives.
  ctx.viewerRegistry.readOrInit(
    absPath,
    fileState.totalLines,
    fileState.sha,
    fileState.mtimeMs,
  );
  // `start_line` was accepted by the schema and then dropped here, so a model
  // that named a search origin got a match from anywhere in the file — and
  // because the search wrapped, usually one *above* the line it asked for.
  const r = ctx.viewerRegistry.find(absPath, parsed.data.pattern, lines, parsed.data.start_line);
  if (!r) {
    return fail(
      "not_found",
      parsed.data.start_line === undefined
        ? `file_find: pattern "${parsed.data.pattern}" not found in ${absPath}`
        : `file_find: pattern "${parsed.data.pattern}" not found in ${absPath} at or after line ${parsed.data.start_line}`,
    );
  }

  const matched = lines.slice(r.view.startLine - 1, r.view.endLine - 1);
  const numbered = numberLines(matched, r.view.startLine);
  return ok(
    {
      kind: "file_find",
      path: absPath,
      startLine: r.view.startLine,
      endLine: r.view.endLine,
      matchedLine: r.matchedLine,
      matchedPattern: r.matchedPattern,
      caseInsensitive: r.caseInsensitive,
      matchCount: countMatches(lines, r.matchedPattern, r.caseInsensitive),
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

  const preState = await readViewerFile(absPath, ctx);
  if (!preState) {
    return fail("not_found", `file_edit: file not found or not readable: ${absPath}`);
  }
  const preContent = preState.content;

  const allLines = preContent.length === 0 ? [] : preContent.split("\n");
  const totalLines = allLines.length;
  const { start_line, end_line, new_content, expected_content } = parsed.data;
  if (start_line < 1 || end_line > totalLines + 1) {
    return fail("invalid_argument", `file_edit: range ${start_line}..${end_line} exceeds the file's ${totalLines} lines`);
  }
  const resolved = resolveEditRange(allLines, start_line, end_line, expected_content);
  if ("error" in resolved) {
    return fail("stale_range", resolved.error);
  }
  const replacementLines = new_content.length === 0 ? [] : new_content.split("\n");
  /*
   * The text this edit replaced, captured before it is overwritten.
   *
   * The transcript derives its diff from the call, and `expected_content` is
   * optional — a model that omits it (the common case) leaves the before side
   * nowhere in the arguments, so the edit card could only show the new text as
   * pure additions. A replacement reported as `+1 -0` is wrong in the way that
   * matters: it says the file grew when it did not, and it hides the line that
   * went away. The old text is in hand right here, so it goes back with the
   * result and the projection prefers it over anything it could infer.
   */
  const replacedLines = allLines.slice(resolved.start - 1, resolved.end);
  const nextLines = [
    ...allLines.slice(0, resolved.start - 1),
    ...replacementLines,
    ...allLines.slice(resolved.end),
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
        startLine: resolved.start,
        endLine: resolved.end,
        totalLines,
        window: [],
        lintVerdict: verdict,
        rolledBack: true,
      },
      Date.now() - started,
    );
  }

  // Persist + read back to refresh registry. When the executor supplies a
  // staging sink the edit joins the WAL instead of hitting disk, so it
  // flushes (or rolls back) atomically with the rest of the turn.
  if (ctx.writeStaged) {
    await ctx.writeStaged(absPath, postContent);
  } else {
    await writeFile(absPath, postContent, "utf8");
  }
  const postFileState = await readViewerFile(absPath, ctx);
  const postTotalLines = postFileState?.totalLines ?? nextLines.length;

  // The returned window is the edit site as it now reads, and the registry is
  // re-anchored onto it. Leaving the viewport where it was before the edit is
  // what makes a following `file_view` serve pre-edit line
  // numbers, which is how edit chains drift onto the wrong lines.
  const halfWindow = Math.floor(DEFAULT_WINDOW / 2);
  const postStart = Math.max(1, resolved.start - halfWindow);
  const postEnd = Math.min(postTotalLines + 1, postStart + DEFAULT_WINDOW);
  const sliced = nextLines.slice(postStart - 1, postEnd - 1);
  const numbered = numberLines(sliced, postStart);

  if (postFileState) {
    ctx.viewerRegistry.set({
      path: absPath,
      anchorLine: resolved.start,
      startLine: postStart,
      endLine: postEnd,
      totalLines: postTotalLines,
      sha256: postFileState.sha,
      mtimeMs: postFileState.mtimeMs,
    });
  }

  return ok(
    {
      kind: "file_edit",
      path: absPath,
      startLine: postStart,
      endLine: postEnd,
      totalLines: postTotalLines,
      window: numbered,
      lintVerdict: verdict,
      /*
       * What the edit replaced, and where it started, so a transcript can draw
       * the removal it would otherwise have to guess at. See `replacedLines`
       * above for why the arguments are not enough.
       */
      replacedText: replacedLines.join("\n"),
      replacedStartLine: resolved.start,
      ...(resolved.relocatedFrom ? { relocatedFrom: resolved.relocatedFrom } : {}),
    },
    Date.now() - started,
  );
}
