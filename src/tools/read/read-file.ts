import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath, relativeWorkspacePath } from "../../policy/paths.js";

const DEFAULT_UNBOUNDED_MAX_LINES = 600;

export async function readFileTool(
  workspaceRoot: string,
  args: { path: string; startLine?: number; endLine?: number },
) {
  let filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  let resolvedFrom: string | undefined;
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    const fallback = await resolveUniqueBasename(workspaceRoot, args.path);
    if (!fallback) throw error;
    resolvedFrom = args.path;
    filePath = fallback;
    content = await readFile(filePath, "utf8");
  }
  const lines = content.split(/\r?\n/);
  const unbounded = args.startLine === undefined && args.endLine === undefined;
  const start = Math.max(1, args.startLine ?? 1);
  const requestedEnd = args.endLine ?? lines.length;
  const end = Math.min(lines.length, unbounded ? Math.min(requestedEnd, DEFAULT_UNBOUNDED_MAX_LINES) : requestedEnd);
  const selected = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`);
  const truncated = unbounded && end < lines.length;
  const notes = [
    truncated
      ? "Large unbounded read was limited to a preview. Use grep_search, skim_file, or read_file with startLine/endLine for the relevant range."
      : "",
    resolvedFrom
      ? `Requested path '${resolvedFrom}' was not found, so read_file used the unique same-basename match '${relativeWorkspacePath(workspaceRoot, filePath)}'.`
      : "",
  ].filter(Boolean);

  return {
    path: filePath,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    truncated,
    ...(notes.length ? { note: notes.join(" ") } : {}),
    ...(resolvedFrom
      ? {
          resolvedFrom,
          resolvedPath: relativeWorkspacePath(workspaceRoot, filePath),
        }
      : {}),
    content: selected.join("\n"),
  };
}

async function resolveUniqueBasename(workspaceRoot: string, requestedPath: string): Promise<string | undefined> {
  const basename = path.basename(requestedPath);
  if (!basename || basename === "." || basename === "..") return undefined;
  const matches: string[] = [];
  await collectBasenameMatches(path.resolve(workspaceRoot), basename, matches);
  return matches.length === 1 ? matches[0] : undefined;
}

async function collectBasenameMatches(dir: string, basename: string, matches: string[]): Promise<void> {
  if (matches.length > 1) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (matches.length > 1) return;
    if (entry.name === ".git" || entry.name === "scratchpad" || entry.name === "node_modules" || entry.name === "build" || entry.name === "dist") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) {
      matches.push(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      await collectBasenameMatches(fullPath, basename, matches);
    }
  }
}
