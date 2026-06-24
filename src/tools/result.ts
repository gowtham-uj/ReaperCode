/**
 * Canonical tool result envelope. Every core tool returns this shape so the
 * model always knows how to interpret the result. The shape is deliberately
 * stable: `ok` carries the boolean, `error` is a structured object with a
 * human-readable message, and tool-specific fields live alongside.
 *
 * Inspired by Codex / Claude Code / Hermes / OpenCode: tool results should be
 * uniform so the model can pattern-match on `ok: false` and read `error.code`
 * to recover from mistakes.
 */
export type ToolErrorCode =
  | "not_found"
  | "permission_denied"
  | "invalid_argument"
  | "io_error"
  | "too_large"
  | "binary_file"
  | "timeout"
  | "patch_failed"
  | "shell_failed"
  | "syntax_error"
  | "conflict"
  | "unsupported";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** Optional structured detail, e.g. patch diff, command exit, line number. */
  details?: Record<string, unknown>;
}

export interface ToolOk<T> {
  ok: true;
  /** Whether the model should consider the task fully done. */
  done?: boolean;
  /** Brief human-readable note the model can quote back. */
  note?: string;
  /** Tool-specific payload. */
  result: T;
}

export interface ToolErr {
  ok: false;
  /** Whether the model should consider the task fully done. False: keep trying. */
  done: false;
  /** Brief human-readable note the model can quote back. */
  note?: string;
  error: ToolError;
  /** Optional partial result, e.g. a partial diff that failed to apply. */
  partial?: unknown;
}

export type ToolResult<T = unknown> = ToolOk<T> | ToolErr;

export function ok<T>(result: T, opts: { done?: boolean; note?: string } = {}): ToolOk<T> {
  return { ok: true, ...(opts.done !== undefined ? { done: opts.done } : {}), ...(opts.note ? { note: opts.note } : {}), result };
}

export function fail(
  code: ToolErrorCode,
  message: string,
  opts: { details?: Record<string, unknown>; note?: string; partial?: unknown } = {},
): ToolErr {
  return {
    ok: false,
    done: false,
    ...(opts.note ? { note: opts.note } : {}),
    error: { code, message, ...(opts.details ? { details: opts.details } : {}) },
    ...(opts.partial !== undefined ? { partial: opts.partial } : {}),
  };
}