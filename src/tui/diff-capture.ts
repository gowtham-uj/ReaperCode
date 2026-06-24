/**
 * diff-capture.ts — compute a unified diff between the disk content
 * before a mutating tool call and after, given the call's args.
 *
 * For `write_file` and `replace_in_file` we read the new content from
 * `args` and the old content from disk (or "" if the file doesn't
 * exist). For `edit_file` we need both `find` and `new_string` to
 * reconstruct the diff: read the file, splice `new_string` for the
 * first match of `find`, and diff the result against the original.
 *
 * Returns null if the tool is not mutating or if reconstruction fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, relative, extname } from "node:path";
import { createPatch, parsePatch } from "diff";

import type { TuiDiff, TuiDiffHunk, TuiDiffLine } from "./types.js";

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "replace_in_file", "create_file"]);

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

function resolvePath(p: string, workspaceRoot: string): string {
  if (isAbsolute(p)) return p;
  return join(workspaceRoot, p);
}

function readSafe(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

interface WriteFileArgs {
  path: string;
  content?: string;
  body?: string;
  text?: string;
}

interface EditFileArgs {
  path: string;
  find?: string;
  new_string?: string;
  old_string?: string;
  replacement?: string;
  replace?: string;
}

interface ReplaceInFileArgs {
  path: string;
  find?: string;
  replace?: string;
  replacement?: string;
  new_string?: string;
  old_string?: string;
}

function extractString(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function asWriteArgs(args: unknown): WriteFileArgs | null {
  const path = extractString(args, ["path", "filePath"]);
  if (!path) return null;
  const content = extractString(args, ["content", "body", "text", "data", "contents"]);
  return content === undefined ? null : { path, content };
}

function asEditArgs(args: unknown): EditFileArgs | null {
  const path = extractString(args, ["path", "filePath"]);
  if (!path) return null;
  const find = extractString(args, ["find", "matchText", "old_string", "search"]);
  const new_string = extractString(args, ["new_string", "replace", "replacement", "newText", "substitute"]);
  if (find === undefined || new_string === undefined) return null;
  return { path, find, new_string };
}

function asReplaceArgs(args: unknown): ReplaceInFileArgs | null {
  const path = extractString(args, ["path", "filePath"]);
  if (!path) return null;
  const find = extractString(args, ["find", "matchText", "old_string", "search"]);
  const replace = extractString(args, ["replace", "new_string", "replacement", "substitute"]);
  if (find === undefined || replace === undefined) return null;
  return { path, find, replace };
}

/** Compute the new content for an edit_file / replace_in_file call by
 *  splicing the replacement into the first occurrence of `find`. */
function spliceFirst(haystack: string, find: string, replacement: string): string | null {
  const idx = haystack.indexOf(find);
  if (idx < 0) return null;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + find.length);
}

function patchToHunks(patch: ReturnType<typeof parsePatch>[number]): TuiDiffHunk[] {
  const out: TuiDiffHunk[] = [];
  for (const h of patch.hunks) {
    const lines: TuiDiffLine[] = [];
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    // The leading " hunk header" line is optional; we render it from the
    // hunk's metadata via a synthetic TuiDiffLine of kind "hunk".
    lines.push({
      kind: "hunk",
      text: h.oldStart === -1 ? h.newStart.toString() : `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      oldLine: h.oldStart,
      newLine: h.newStart,
    });
    for (const line of h.lines) {
      const c = line.charAt(0);
      const text = line.slice(1);
      if (c === "+") {
        lines.push({ kind: "add", text, oldLine: null, newLine });
        newLine += 1;
      } else if (c === "-") {
        lines.push({ kind: "del", text, oldLine, newLine: null });
        oldLine += 1;
      } else if (c === " ") {
        lines.push({ kind: "ctx", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      } else {
        // "\ No newline at end of file" — drop for now.
      }
    }
    out.push({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines,
    });
  }
  return out;
}

/** Compute the TuiDiff for a tool call. Returns null for non-mutating
 *  tools or when reconstruction fails (e.g. the find string didn't
 *  match). */
export function diffForToolCall(
  toolName: string,
  args: unknown,
  workspaceRoot: string,
): TuiDiff | null {
  if (!isMutatingTool(toolName)) return null;
  const absPath = (() => {
    if (!args || typeof args !== "object") return null;
    const p = (args as Record<string, unknown>).path;
    if (typeof p !== "string") return null;
    return resolvePath(p, workspaceRoot);
  })();
  if (!absPath) return null;
  const relPath = relative(workspaceRoot, absPath) || absPath;
  const before = readSafe(absPath);

  let after = before;
  if (toolName === "write_file" || toolName === "create_file") {
    const w = asWriteArgs(args);
    if (!w || w.content === undefined) return null;
    after = w.content;
  } else if (toolName === "edit_file") {
    const e = asEditArgs(args);
    if (!e) return null;
    const spliced = spliceFirst(before, e.find ?? "", e.new_string ?? "");
    if (spliced === null) return null;
    after = spliced;
  } else if (toolName === "replace_in_file") {
    const r = asReplaceArgs(args);
    if (!r) return null;
    const spliced = spliceFirst(before, r.find ?? "", r.replace ?? "");
    if (spliced === null) return null;
    after = spliced;
  } else {
    return null;
  }

  if (before === after) {
    return { path: relPath, before, after, hunks: [] };
  }

  const patch = createPatch(relPath, before, after, undefined, undefined, { context: 3 });
  const parsed = parsePatch(patch);
  const hunks: TuiDiffHunk[] = [];
  for (const p of parsed) hunks.push(...patchToHunks(p));
  const language = langForExt(extname(relPath));
  return language !== undefined
    ? { path: relPath, before, after, hunks, language }
    : { path: relPath, before, after, hunks };
}

/** Map a file extension to a shiki-compatible language id. Returns
 *  undefined for unknown extensions — DiffCard falls back to plain. */
export function langForExt(ext: string): string | undefined {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (!e) return undefined;
  switch (e) {
    case "ts": case "tsx": case "cts": case "mts": return "ts";
    case "js": case "jsx": case "mjs": case "cjs": return "js";
    case "json": case "jsonc": return "json";
    case "sh": case "bash": case "zsh": return "bash";
    case "py": case "pyi": return "python";
    case "md": case "markdown": return "md";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
    case "rs": return "rust";
    case "go": return "go";
    case "java": return "java";
    case "rb": return "ruby";
    case "php": return "php";
    case "html": case "htm": return "html";
    case "css": return "css";
    case "scss": case "sass": return "scss";
    case "sql": return "sql";
    case "diff": case "patch": return "diff";
    default: return undefined;
  }
}