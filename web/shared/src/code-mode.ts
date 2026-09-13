/**
 * The payload the `eval` tool returns, typed.
 *
 * Code Mode reports on itself: status, duration, every inner Reaper tool call,
 * console output, and the value the script produced. That report is the whole
 * interface between the sandbox and everything downstream — the model reads it
 * to decide what to fix, the transcript renders it, and the CLI prints it — so
 * the shape is written down once here rather than re-guessed by each reader.
 *
 * Parsing is deliberately tolerant. The payload crosses a JSON-RPC boundary and
 * is versioned only by the fact that both ends ship together, but a transcript
 * also renders results recorded by an older build and replayed from a journal;
 * a reader that threw on an unexpected field would blank out history that is
 * merely slightly stale. Every field is validated by shape and everything
 * unrecognised is dropped.
 */

export type CodeModeStatus = "completed" | "timeout" | "cancelled" | "memory" | "tool_call_limit" | "error";

export interface CodeModeToolCall {
  name: string;
  ok: boolean;
  durationMs: number;
  /** `"CODE: message"` — the code already baked in by the eval tool. */
  error?: string;
}

export interface CodeModeConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface CodeModeError {
  name: string;
  message: string;
  /** Set when a Reaper tool rejected the call and the rejection escaped. */
  tool?: string;
  code?: string;
  hint?: string;
}

export interface CodeModeResult {
  status: CodeModeStatus;
  durationMs: number;
  toolCalls: CodeModeToolCall[];
  /** Absent when nothing was printed; present-and-empty would render an empty box. */
  console?: CodeModeConsoleEntry[];
  consoleTruncated?: boolean;
  /** The value the script returned, when it returned one. */
  value?: unknown;
  resultTruncated?: boolean;
  resultBytes?: number;
  error?: CodeModeError;
  failedTool?: string;
  note?: string;
}

const STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "timeout",
  "cancelled",
  "memory",
  "tool_call_limit",
  "error",
]);

const LEVELS: ReadonlySet<string> = new Set(["log", "info", "warn", "error", "debug"]);

/**
 * Read a tool result as a Code Mode report, or `undefined` when it is not one.
 *
 * Returning undefined rather than a defaulted object is what lets the view
 * distinguish "this eval produced no report" (a call that failed before the
 * sandbox started) from "this eval ran and reported nothing", which read very
 * differently on screen and are drawn differently.
 */
export function readCodeModeResult(raw: unknown): CodeModeResult | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === "string" && STATUSES.has(record.status)
    ? (record.status as CodeModeStatus)
    : undefined;
  if (!status) return undefined;

  const result: CodeModeResult = {
    status,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
    toolCalls: readToolCalls(record.toolCalls),
  };

  const console = readConsole(record.console);
  if (console.length > 0) result.console = console;
  if (record.consoleTruncated === true) result.consoleTruncated = true;
  if ("value" in record) result.value = record.value;
  if (record.resultTruncated === true) result.resultTruncated = true;
  if (typeof record.resultBytes === "number") result.resultBytes = record.resultBytes;
  if (typeof record.note === "string" && record.note) result.note = record.note;
  if (typeof record.failedTool === "string" && record.failedTool) result.failedTool = record.failedTool;

  const error = readError(record.error);
  if (error) result.error = error;
  return result;
}

function readToolCalls(raw: unknown): CodeModeToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeModeToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    out.push({
      name: record.name,
      ok: record.ok !== false,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
      ...(typeof record.error === "string" && record.error ? { error: record.error } : {}),
    });
  }
  return out;
}

function readConsole(raw: unknown): CodeModeConsoleEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeModeConsoleEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string") continue;
    const level = typeof record.level === "string" && LEVELS.has(record.level)
      ? (record.level as CodeModeConsoleEntry["level"])
      : "log";
    out.push({ level, text: record.text });
  }
  return out;
}

function readError(raw: unknown): CodeModeError | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name ? record.name : "Error";
  const message = typeof record.message === "string" ? record.message : "";
  if (!message && !record.tool) return undefined;
  return {
    name,
    message,
    ...(typeof record.tool === "string" ? { tool: record.tool } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.hint === "string" ? { hint: record.hint } : {}),
  };
}

/**
 * Whether this result is worth showing without being asked for.
 *
 * The transcript rule for every tool is the same: a success is a row, a failure
 * is a row plus its reason. Code Mode obeys it, and this is where that gets
 * decided so the three surfaces — web, CLI, and the collapsed transcript — all
 * answer it the same way.
 */
export function codeModeFailureText(result: CodeModeResult | undefined, fallback?: string): string | undefined {
  if (!result) return fallback;
  if (result.error) {
    const where = result.error.tool ? `${result.error.tool}: ` : "";
    return `${result.error.name}: ${where}${result.error.message}`;
  }
  if (result.failedTool) return `${result.failedTool} failed`;
  if (result.note) return result.note;
  return undefined;
}
