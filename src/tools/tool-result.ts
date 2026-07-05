/**
 * tools/tool-result.ts — normalized tool result envelope.
 *
 * The legacy executor returns a flat ToolResult with a single `output` field.
 * This module converts that into structured fields so context management can
 * keep summaries inline, preserve errors, and prune safe stale results.
 */

export interface NormalizedToolResult {
  readonly ok: boolean;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly durationMs: number;
  readonly content: unknown;
  readonly details?: NormalizedToolResultDetails;
  readonly meta?: Record<string, unknown>;
  readonly diagnostics?: ToolDiagnostic[];
  readonly artifacts?: ToolArtifactRef[];
  readonly isError: boolean;
  readonly useless: boolean;
  readonly advisories?: ToolAdvisory[];
  readonly error?: { code: string; message: string; details?: unknown };
}

export interface NormalizedToolResultDetails {
  readonly kind: "text" | "json" | "file" | "process" | "none";
  readonly summary?: string;
  readonly bytes?: number;
  readonly lines?: number;
}

export interface ToolDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly source: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface ToolArtifactRef {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly bytes: number;
}

export interface ToolAdvisory {
  readonly code: string;
  readonly message: string;
}

interface LegacyToolResultLike {
  ok: boolean;
  toolCallId: string;
  name: string;
  args?: unknown;
  durationMs?: number;
  output?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface ModelVisibleToolResult {
  ok: boolean;
  summary: string;
  content?: unknown;
  error?: { code: string; message: string; details?: unknown };
  artifacts?: ToolArtifactRef[];
  diagnostics?: ToolDiagnostic[];
}

function byteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function lineCount(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split("\n").length;
}

function tryParseJson(value: unknown): unknown | undefined {
  if (typeof value !== "string") return typeof value === "object" && value !== null ? value : undefined;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

function summaryFor(name: string, ok: boolean, output: unknown, args: unknown, error?: { message: string }): string {
  if (!ok) return `${name} failed: ${error?.message ?? "unknown error"}`;
  const parsed = tryParseJson(output);
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  const path = typeof record?.path === "string" ? record.path : pathFromArgs(args);
  if (path && ["file_view", "file_scroll", "file_find", "read_file", "view_file", "write_file", "file_edit"].includes(name)) {
    return `${name} ok: ${path}`;
  }
  if (name === "bash") {
    const cmd = args && typeof args === "object" ? ((args as Record<string, unknown>).cmd ?? (args as Record<string, unknown>).command) : undefined;
    return typeof cmd === "string" ? `bash ok: ${cmd}` : "bash ok";
  }
  return `${name} ok`;
}

function detailsKind(name: string, output: unknown): NormalizedToolResultDetails["kind"] {
  if (output === undefined || output === null || output === "") return "none";
  if (tryParseJson(output) !== undefined) return "json";
  if (["file_view", "file_scroll", "file_find", "read_file", "view_file", "skim_file"].includes(name)) return "file";
  if (["bash", "read_background_output", "job"].includes(name)) return "process";
  return "text";
}

function safeToPrune(name: string, ok: boolean): boolean {
  if (!ok) return false;
  return [
    "file_view",
    "file_scroll",
    "file_find",
    "read_file",
    "view_file",
    "write_file",
    "file_edit",
    "replace_in_file",
    "replace_symbol",
    "edit_file",
    "bash",
  ].includes(name);
}

function pruneReplacement(name: string, bytes: number, args: unknown): string {
  if (name === "write_file" || name === "file_edit" || name === "replace_in_file" || name === "replace_symbol" || name === "edit_file") {
    const path = pathFromArgs(args);
    return path ? `[${name}: ${path}]` : `[${name}: completed]`;
  }
  if (name === "delete_file") {
    const path = pathFromArgs(args);
    return path ? `[delete_file: ${path}]` : `[delete_file: completed]`;
  }
  return `[${name}: completed, ${bytes} bytes]`;
}

export function normalizeToolResult(result: LegacyToolResultLike): NormalizedToolResult {
  const isError = !result.ok && !!result.error;
  const bytes = byteLength(result.output);
  const summary = summaryFor(result.name, result.ok, result.output, result.args, result.error);
  const canPrune = safeToPrune(result.name, result.ok);
  const contentLines = lineCount(result.output);
  return {
    ok: result.ok,
    toolCallId: result.toolCallId,
    name: result.name,
    args: result.args,
    durationMs: result.durationMs ?? 0,
    content: result.output,
    details: {
      kind: detailsKind(result.name, result.output),
      summary,
      bytes,
      ...(contentLines !== undefined ? { lines: contentLines } : {}),
    },
    meta: {
      bytesOriginal: bytes,
      bytesInline: bytes,
      safeToPrune: canPrune,
      ...(canPrune ? { pruneReplacement: pruneReplacement(result.name, bytes, result.args) } : {}),
    },
    ...(isError && result.error ? { error: result.error } : {}),
    ...(isError && result.error ? { diagnostics: [{ severity: "error", source: result.name, message: result.error.message } satisfies ToolDiagnostic] } : {}),
    isError,
    useless: false,
  };
}

export function renderNormalizedToolResultForModel(result: NormalizedToolResult): ModelVisibleToolResult {
  const summary = result.details?.summary ?? `${result.name} ${result.ok ? "ok" : "failed"}`;
  if (!result.ok) {
    const diagnostic = result.diagnostics?.find((d) => d.severity === "error");
    return {
      ok: false,
      summary,
      error: result.error ?? { code: "tool_error", message: diagnostic?.message ?? summary },
      ...(result.artifacts?.length ? { artifacts: result.artifacts } : {}),
    };
  }
  return {
    ok: true,
    summary,
    content: result.content,
    ...(result.artifacts?.length ? { artifacts: result.artifacts } : {}),
    ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}),
  };
}
