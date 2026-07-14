/**
 * context/supersede-prune.ts — drop stale tool results only when a later
 * observation proves that it contains the same file version and covers the
 * earlier line window.
 *
 * Prompt-cache safety and explicit `useless` flags retain their prior
 * behavior. A path match by itself is never enough to discard file evidence.
 */

import path from "node:path";

export interface SupersedePruneOptions {
  /** Number of leading messages to leave untouched (prompt-cache warm prefix). Default 1. */
  warmPrefixCount?: number;
  /** Placeholder for superseded reads. */
  supersededPlaceholder?: string;
  /** Placeholder for useless-flagged results. */
  uselessPlaceholder?: string;
}

export interface SupersedePruneResult {
  pruned: number;
  savedChars: number;
  performed: boolean;
}

interface ObservationMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  useless?: unknown;
  meta?: unknown;
}

interface ToolMeta {
  name: string;
  args?: unknown;
  useless: boolean;
}

interface FileObservation {
  path: string;
  sha256: string;
  startLine: number | null;
  endLineExclusive: number | null;
  exactWholeFile: boolean;
}

const READ_OBSERVATION_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  file_view: true,
  file_scroll: true,
  read_file: true,
  view_file: true,
});
const DEFAULT_SUPERSEDED = "[superseded: file re-read later]";
const DEFAULT_USELESS = "[useless tool result pruned]";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shared read-family classification for supersede pruning and shake. */
export function isReadObservationTool(name: string): boolean {
  return READ_OBSERVATION_TOOLS[name] === true;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractResultRecord(content: unknown): Record<string, unknown> | null {
  let record = parseRecord(content);
  for (let depth = 0; record && depth < 3; depth += 1) {
    if (typeof record.sha256 === "string") return record;
    record = parseRecord(record.content ?? record.output);
  }
  return null;
}

function extractPathFromArgs(args: unknown): string | null {
  const parsed = parseRecord(args);
  if (!parsed) return null;
  const candidate = parsed.path ?? parsed.file ?? parsed.file_path ?? parsed.filename;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function normalizeObservedPath(filePath: string): string | null {
  const slashPath = filePath.trim().replace(/\\/g, "/");
  if (!slashPath) return null;
  const normalized = path.posix.normalize(slashPath);
  if (!normalized || normalized === ".") return null;
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function findToolMeta(
  messages: readonly ObservationMessage[],
  toolIdx: number,
): ToolMeta {
  const toolMessage = messages[toolIdx];
  const callId = typeof toolMessage?.tool_call_id === "string" ? toolMessage.tool_call_id : undefined;
  let name = "tool";
  let args: unknown;
  if (callId) {
    for (let i = toolIdx - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
      for (const rawCall of message.tool_calls) {
        if (!isRecord(rawCall) || rawCall.id !== callId || !isRecord(rawCall.function)) continue;
        if (typeof rawCall.function.name === "string") name = rawCall.function.name;
        args = rawCall.function.arguments;
        break;
      }
      if (name !== "tool") break;
    }
  }
  const metadata = isRecord(toolMessage?.meta) ? toolMessage.meta : null;
  return {
    name,
    args,
    useless: toolMessage?.useless === true || metadata?.useless === true,
  };
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)
    ? value
    : null;
}

function extractFileObservation(
  toolName: string,
  args: unknown,
  content: unknown,
): FileObservation | null {
  const result = extractResultRecord(content);
  if (!result || typeof result.sha256 !== "string" || !SHA256_PATTERN.test(result.sha256)) {
    return null;
  }
  const rawPath = typeof result.path === "string" ? result.path : extractPathFromArgs(args);
  const normalizedPath = rawPath ? normalizeObservedPath(rawPath) : null;
  if (!normalizedPath) return null;

  const startLine = finiteInteger(result.startLine);
  const endLine = finiteInteger(result.endLine);
  const totalLines = finiteInteger(result.totalLines);
  const isImageWholeFile =
    (toolName === "read_file" || toolName === "view_file") && result.kind === "image";
  const endLineExclusive =
    endLine === null
      ? null
      : toolName === "file_view" || toolName === "file_scroll"
        ? endLine
        : endLine + 1;
  const exactWholeFile =
    isImageWholeFile ||
    (
      startLine === 1 &&
      endLineExclusive !== null &&
      totalLines !== null &&
      endLineExclusive === totalLines + 1 &&
      result.truncated === false
    );

  if (!exactWholeFile && (
    startLine === null ||
    endLineExclusive === null ||
    startLine < 1 ||
    endLineExclusive <= startLine
  )) {
    return null;
  }
  return {
    path: normalizedPath,
    sha256: result.sha256.toLocaleLowerCase("en-US"),
    startLine,
    endLineExclusive,
    exactWholeFile,
  };
}

function laterCoversEarlier(later: FileObservation, earlier: FileObservation): boolean {
  if (later.path !== earlier.path || later.sha256 !== earlier.sha256) return false;
  if (later.exactWholeFile && earlier.exactWholeFile) return true;
  return (
    later.startLine !== null &&
    later.endLineExclusive !== null &&
    earlier.startLine !== null &&
    earlier.endLineExclusive !== null &&
    later.startLine <= earlier.startLine &&
    later.endLineExclusive >= earlier.endLineExclusive
  );
}

/**
 * Return tool-result indices whose observations are proven redundant by one
 * later read. Results without a valid SHA-256 and a provable line window are
 * deliberately absent.
 */
export function findSupersededReadIndices(
  messages: readonly ObservationMessage[],
  warmPrefixCount = 0,
): Set<number> {
  const protectedPrefix = Math.max(0, warmPrefixCount);
  const laterByPath = new Map<string, FileObservation[]>();
  const superseded = new Set<number>();

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "tool") continue;
    const meta = findToolMeta(messages, i);
    if (meta.useless || !isReadObservationTool(meta.name)) continue;
    const observation = extractFileObservation(meta.name, meta.args, message.content);
    if (!observation) continue;
    const later = laterByPath.get(observation.path) ?? [];
    if (i >= protectedPrefix && later.some((candidate) => laterCoversEarlier(candidate, observation))) {
      superseded.add(i);
    }
    later.push(observation);
    laterByPath.set(observation.path, later);
  }
  return superseded;
}

/**
 * Mutates `messages` in place. Safe to call every turn — already-pruned
 * placeholders are skipped.
 */
export function pruneSupersededToolResults(
  messages: Array<Record<string, unknown>>,
  options: SupersedePruneOptions = {},
): SupersedePruneResult {
  const warmPrefixCount = Math.max(0, options.warmPrefixCount ?? 1);
  const supersededPlaceholder = options.supersededPlaceholder ?? DEFAULT_SUPERSEDED;
  const uselessPlaceholder = options.uselessPlaceholder ?? DEFAULT_USELESS;
  const supersededIndices = findSupersededReadIndices(messages, warmPrefixCount);
  const uselessIndices: number[] = [];

  for (let i = warmPrefixCount; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== "tool") continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (content.startsWith("[") && content.endsWith("]")) continue;
    if (findToolMeta(messages, i).useless) uselessIndices.push(i);
  }

  let pruned = 0;
  let savedChars = 0;
  for (const index of supersededIndices) {
    const message = messages[index];
    if (!message) continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (content === supersededPlaceholder) continue;
    savedChars += Math.max(0, content.length - supersededPlaceholder.length);
    message.content = supersededPlaceholder;
    pruned += 1;
  }

  for (const index of uselessIndices) {
    const message = messages[index];
    if (!message) continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (content === uselessPlaceholder) continue;
    savedChars += Math.max(0, content.length - uselessPlaceholder.length);
    message.content = uselessPlaceholder;
    pruned += 1;
  }

  return { pruned, savedChars, performed: pruned > 0 };
}
