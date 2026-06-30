import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath, relativeWorkspacePath } from "../../policy/paths.js";

const DEFAULT_UNBOUNDED_MAX_LINES = 600;

export interface TextReadFileResult {
  kind: "text";
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  note?: string;
  resolvedFrom?: string;
  resolvedPath?: string;
  content: string;
}

export interface ImageReadFileResult {
  kind: "image";
  path: string;
  mimeType: string;
  bytes: number;
  base64: string;
  note?: string;
  resolvedFrom?: string;
  resolvedPath?: string;
}

export type ReadFileToolResult = TextReadFileResult | ImageReadFileResult;

export async function readFileTool(
  workspaceRoot: string,
  args: { path: string; startLine?: number; endLine?: number },
): Promise<ReadFileToolResult> {
  let filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  let resolvedFrom: string | undefined;
  let contentBuffer: Buffer;
  try {
    contentBuffer = await readFile(filePath);
  } catch (error) {
    const fallback = await resolveUniqueBasename(workspaceRoot, args.path);
    if (!fallback) throw error;
    resolvedFrom = args.path;
    filePath = fallback;
    contentBuffer = await readFile(filePath);
  }
  const imageMimeType = detectSupportedImageMimeType(contentBuffer, filePath);
  if (imageMimeType) {
    const notes = [
      "Image file read as an attachment payload.",
      resolvedFrom
        ? `Requested path '${resolvedFrom}' was not found, so read_file used the unique same-basename match '${relativeWorkspacePath(workspaceRoot, filePath)}'.`
        : "",
    ].filter(Boolean);
    return {
      path: filePath,
      kind: "image",
      mimeType: imageMimeType,
      bytes: contentBuffer.length,
      base64: contentBuffer.toString("base64"),
      ...(notes.length ? { note: notes.join(" ") } : {}),
      ...(resolvedFrom
        ? {
            resolvedFrom,
            resolvedPath: relativeWorkspacePath(workspaceRoot, filePath),
          }
        : {}),
    };
  }
  const content = contentBuffer.toString("utf8");
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
    kind: "text",
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

function detectSupportedImageMimeType(buffer: Buffer, filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  // BMP has a weak magic number, so require both the magic bytes and a matching extension.
  if (ext === ".bmp" && buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  return undefined;
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
