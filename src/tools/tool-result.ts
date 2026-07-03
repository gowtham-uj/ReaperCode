/**
 * tools/tool-result.ts — Phase 0 skeleton for the normalized tool result envelope.
 *
 * A NormalizedToolResult wraps every tool execution result with structured
 * metadata that drives:
 * - Context compaction (useless/useful classification)
 * - Advisory diagnostics (non-blocking)
 * - Artifact references (spillover handles)
 * - Diagnostic pass-through (lint/tsc results as advisory info)
 *
 * This module is intentionally additive scaffolding in Phase 0.
 * Phase 1 will add adapters that wrap current tool results into this
 * envelope while preserving existing visible output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Normalized result envelope for every tool execution.
 *
 * The existing `ToolResult` type (from types.ts) has `ok`, `output`, `error`,
 * etc. This envelope wraps that with richer metadata. Phase 1 will add an
 * adapter function that converts the current flat ToolResult into this shape
 * and back, so the executor return type doesn't change for existing callers.
 */
export interface NormalizedToolResult {
  /** Whether the tool call succeeded. */
  readonly ok: boolean;
  /** Tool call ID (matches the model's tool_call id). */
  readonly toolCallId: string;
  /** Tool name. */
  readonly name: string;
  /** Parsed args that were passed to the tool. */
  readonly args: unknown;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Primary content returned to the model (string or structured object). */
  readonly content: unknown;
  /** Secondary details (e.g., lint warnings, file stats). */
  readonly details?: NormalizedToolResultDetails;
  /** Free-form metadata (e.g., bytes written, lines matched). */
  readonly meta?: Record<string, unknown>;
  /** Advisory diagnostics that do NOT block the write. */
  readonly diagnostics?: ToolDiagnostic[];
  /** References to spillover artifacts (e.g., large stdout stored on disk). */
  readonly artifacts?: ToolArtifactRef[];
  /** True if the tool call itself errored (schema failure, exception). */
  readonly isError: boolean;
  /** True if the result carries no useful signal (e.g., no-op read). */
  readonly useless: boolean;
  /** Advisory warnings (non-blocking). */
  readonly advisories?: ToolAdvisory[];
}

/** Structured secondary details. */
export interface NormalizedToolResultDetails {
  /** Output type classifier. */
  readonly kind: "text" | "json" | "file" | "process" | "none";
  /** Human-readable summary for context compaction. */
  readonly summary?: string;
  /** Byte count of the primary content (if applicable). */
  readonly bytes?: number;
  /** Line count of the primary content (if applicable). */
  readonly lines?: number;
}

/** A single advisory diagnostic from a tool execution. */
export interface ToolDiagnostic {
  /** Severity (never blocks). */
  readonly severity: "info" | "warning" | "error";
  /** Source (e.g., "tsc", "eslint", "bash"). */
  readonly source: string;
  /** Diagnostic message. */
  readonly message: string;
  /** Optional file path the diagnostic refers to. */
  readonly file?: string;
  /** Optional line number. */
  readonly line?: number;
}

/** Reference to a spillover artifact. */
export interface ToolArtifactRef {
  /** Unique artifact ID (for `get_tool_output`). */
  readonly id: string;
  /** Human label. */
  readonly label: string;
  /** Path on disk or artifact store key. */
  readonly path: string;
  /** Size in bytes. */
  readonly bytes: number;
}

/** Non-blocking advisory. */
export interface ToolAdvisory {
  /** Advisory code (e.g., "stale_read", "large_output"). */
  readonly code: string;
  /** Human-readable message. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Skeleton adapter (Phase 0: stub; Phase 1 will implement)
// ---------------------------------------------------------------------------

/**
 * Wrap a legacy ToolResult (flat shape from the executor) into a
 * NormalizedToolResult envelope.
 *
 * Phase 0: stub that returns a minimal envelope.
 * Phase 1: full implementation with diagnostics, artifacts, advisories.
 */
export function normalizeToolResult(
  result: {
    ok: boolean;
    toolCallId: string;
    name: string;
    args?: unknown;
    durationMs?: number;
    output?: unknown;
    error?: { code: string; message: string };
  },
): NormalizedToolResult {
  const isError = !result.ok && !!result.error;
  return {
    ok: result.ok,
    toolCallId: result.toolCallId,
    name: result.name,
    args: result.args,
    durationMs: result.durationMs ?? 0,
    content: result.output,
    isError,
    useless: false,
  };
}
