import { existsSync } from "node:fs";
import { runVerificationCommand, type VerificationCommand } from "../verify/runner.js";
import { runShellCommandTool, isForegroundShellResult } from "../tools/global/run-shell-command.js";
import type { ToolCall } from "../tools/types.js";

/**
 * Stricter completion gate for `complete_task`.
 *
 * The model must emit `complete_task` as the *only* tool call in the batch, with
 * a non-empty `args.summary` of at least 20 characters. Optional structured
 * fields (`files_changed`, `tests_run`, `known_issues`, `confidence`) are
 * validated when present but not required.
 *
 * `complete_task` is treated as a *request for verification*, not a
 * completion. After the model emits a valid signal, the gate runs a
 * verification step and only marks the task complete when:
 *   `canComplete = hasOnlyCompleteTaskCall && hasValidCompletionArgs && verificationPassed`
 *
 * If verification fails, the gate feeds the failure back to the model and the
 * loop continues. Two counters are tracked:
 *   - `completionSignalAttempts`: increments when the model emits a valid
 *     `complete_task` signal (regardless of whether verification passed).
 *   - `verificationFailureAttempts`: increments only when the verification
 *     step rejects the model-claimed completion.
 */

export const COMPLETION_GATE_MIN_SUMMARY_CHARS = 20;
export const COMPLETION_GATE_MAX_VERIFICATION_ATTEMPTS = 3;

/**
 * `REAPER_STRICT_COMPLETION_GATE` is an escape hatch. When set to "false"
 * (or "0"), the runtime gate accepts the legacy complete_task shape (any
 * non-empty summary, mixed batches allowed) and skips the per-gate
 * verification step. This is intended for unit/integration test fixtures
 * that exercise other behaviors and need to short-circuit the gate. Real
 * autonomous runs leave the strict gate enabled (the default).
 */
export function isStrictCompletionGateEnabled(): boolean {
  const raw = (process.env.REAPER_STRICT_COMPLETION_GATE ?? "true").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  return true;
}

export type CompletionConfidence = "low" | "medium" | "high";

export interface CompletionStructuredArgs {
  files_changed?: unknown;
  tests_run?: unknown;
  known_issues?: unknown;
  confidence?: unknown;
}

export interface CompletionValidationIssue {
  code:
    | "empty_tool_calls"
    | "mixed_complete_task"
    | "missing_summary"
    | "summary_too_short"
    | "summary_wrong_type"
    | "structured_field_wrong_type"
    | "confidence_invalid"
    | "files_changed_not_array"
    | "tests_run_not_array"
    | "known_issues_not_array"
    | "string_array_entry_invalid";
  message: string;
  field?: string;
}

export type CompletionValidationResult =
  | { ok: true; summary: string; args: Record<string, unknown> }
  | { ok: false; issues: CompletionValidationIssue[] };

export function validateCompletionSignal(plannedToolCalls: ToolCall[]): CompletionValidationResult {
  if (!Array.isArray(plannedToolCalls) || plannedToolCalls.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: "empty_tool_calls",
          message:
            "complete_task was not emitted. Return exactly one complete_task tool call with args.summary (>= 20 chars) describing the finished task, and no other tool calls.",
        },
      ],
    };
  }
  const completionCalls = plannedToolCalls.filter((call) => (call.name as string) === "complete_task");
  if (completionCalls.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: "empty_tool_calls",
          message:
            "complete_task was not emitted. The completion gate requires the model to emit exactly one complete_task tool call. If the task is not yet complete, emit concrete repair/check tool calls instead.",
        },
      ],
    };
  }
  if (plannedToolCalls.length > 1 || completionCalls.length > 1) {
    const otherNames = plannedToolCalls
      .filter((call) => (call.name as string) !== "complete_task")
      .map((call) => call.name)
      .join(", ");
    return {
      ok: false,
      issues: [
        {
          code: "mixed_complete_task",
          message: `complete_task must be the only tool call in the batch. The model also emitted: ${otherNames}. Either drop the other tool calls (if the task is truly complete) or drop complete_task and continue with concrete work.`,
        },
      ],
    };
  }
  const completion = completionCalls[0]!;
  return validateCompletionArgs(completion);
}

export function validateCompletionArgs(
  completionCall: ToolCall,
): CompletionValidationResult {
  const args = (completionCall.args ?? {}) as Record<string, unknown>;
  const summaryRaw = args.summary;
  if (summaryRaw === undefined || summaryRaw === null) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_summary",
          field: "summary",
          message: "complete_task is missing args.summary. Provide a non-empty summary of at least 20 characters describing the finished work.",
        },
      ],
    };
  }
  if (typeof summaryRaw !== "string") {
    return {
      ok: false,
      issues: [
        {
          code: "summary_wrong_type",
          field: "summary",
          message: `complete_task args.summary must be a string, got ${typeof summaryRaw}.`,
        },
      ],
    };
  }
  const summary = summaryRaw.trim();
  if (summary.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_summary",
          field: "summary",
          message:
            "complete_task args.summary is empty. Provide a non-empty summary of at least 20 characters describing the finished work.",
        },
      ],
    };
  }
  if (summary.length < COMPLETION_GATE_MIN_SUMMARY_CHARS) {
    return {
      ok: false,
      issues: [
        {
          code: "summary_too_short",
          field: "summary",
          message: `complete_task args.summary must be at least ${COMPLETION_GATE_MIN_SUMMARY_CHARS} characters of substantive text describing the finished work (got ${summary.length}). A one-word summary is not accepted; explain what was done, what was verified, and the resulting state.`,
        },
      ],
    };
  }
  const fieldIssues = validateStructuredFields({
    files_changed: args.files_changed,
    tests_run: args.tests_run,
    known_issues: args.known_issues,
    confidence: args.confidence,
  });
  if (fieldIssues.length > 0) {
    return { ok: false, issues: fieldIssues };
  }
  return { ok: true, summary, args };
}

function validateStructuredFields(fields: CompletionStructuredArgs): CompletionValidationIssue[] {
  const issues: CompletionValidationIssue[] = [];
  if (fields.files_changed !== undefined) {
    const entry = validateStringArray("files_changed", fields.files_changed);
    if (entry) issues.push(entry);
  }
  if (fields.tests_run !== undefined) {
    const entry = validateStringArray("tests_run", fields.tests_run);
    if (entry) issues.push(entry);
  }
  if (fields.known_issues !== undefined) {
    const entry = validateStringArray("known_issues", fields.known_issues);
    if (entry) issues.push(entry);
  }
  if (fields.confidence !== undefined) {
    if (typeof fields.confidence !== "string" || !["low", "medium", "high"].includes(fields.confidence)) {
      issues.push({
        code: "confidence_invalid",
        field: "confidence",
        message: `complete_task args.confidence must be one of "low" | "medium" | "high" when present, got ${JSON.stringify(fields.confidence)}.`,
      });
    }
  }
  return issues;
}

function validateStringArray(field: string, value: unknown): CompletionValidationIssue | undefined {
  if (!Array.isArray(value)) {
    return {
      code:
        field === "files_changed"
          ? "files_changed_not_array"
          : field === "tests_run"
            ? "tests_run_not_array"
            : "known_issues_not_array",
      field,
      message: `complete_task args.${field} must be an array of non-empty strings when present, got ${typeof value}.`,
    };
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return {
        code: "string_array_entry_invalid",
        field,
        message: `complete_task args.${field}[${index}] must be a non-empty string, got ${typeof entry}.`,
      };
    }
  }
  return undefined;
}

export interface CompletionVerificationOutcome {
  ok: boolean;
  reason: string;
  command?: string;
  commandKind: "test_runner" | "caller_provided" | "tests_run_sh" | "model_referenced_tests_run" | "skipped";
  exitCode?: number;
  outputExcerpt?: string;
}

const TERMINAL_BENCH_RUN_TESTS = "/tests/run-tests.sh";
const TERMINAL_BENCH_RUN_TESTS_APP = "/app/tests/run-tests.sh";

/**
 * Run verification after a valid `complete_task` signal.
 *
 * Resolution order:
 *   1. `REAPER_EXTERNAL_VERIFICATION_COMMAND` (caller-provided) — used by the
 *      terminal-bench CLI when the host sets it.
 *   2. `/tests/run-tests.sh` — terminal-bench canonical verifier.
 *   3. `/app/tests/run-tests.sh` — terminal-bench app-local mirror.
 *   4. The first non-empty `tests_run` entry from the model's
 *      `complete_task` arguments.
 *   5. Skip with `commandKind: "skipped"` and ask the model to provide a
 *      verification command.
 */
export async function runCompletionVerification(input: {
  workspaceRoot: string;
  completionArgs: Record<string, unknown>;
}): Promise<CompletionVerificationOutcome> {
  const caller = process.env.REAPER_EXTERNAL_VERIFICATION_COMMAND?.trim();
  if (caller) {
    const result = await runVerificationCommand(input.workspaceRoot, { command: caller } as VerificationCommand);
    return buildOutcome(result, "caller_provided", caller);
  }
  if (existsSync(TERMINAL_BENCH_RUN_TESTS)) {
    const result = await runVerificationCommand(input.workspaceRoot, { command: `bash ${TERMINAL_BENCH_RUN_TESTS}` } as VerificationCommand);
    return buildOutcome(result, "tests_run_sh", `bash ${TERMINAL_BENCH_RUN_TESTS}`);
  }
  if (existsSync(TERMINAL_BENCH_RUN_TESTS_APP)) {
    const command = `cp ${TERMINAL_BENCH_RUN_TESTS_APP} ${TERMINAL_BENCH_RUN_TESTS} 2>/dev/null; bash ${TERMINAL_BENCH_RUN_TESTS}`;
    const result = await runVerificationCommand(input.workspaceRoot, { command } as VerificationCommand);
    return buildOutcome(result, "tests_run_sh", command);
  }
  const modelTests = firstNonEmptyString(input.completionArgs.tests_run);
  if (modelTests) {
    const result = await runVerificationCommand(input.workspaceRoot, { command: modelTests } as VerificationCommand);
    return buildOutcome(result, "model_referenced_tests_run", modelTests);
  }
  // Fall back to a "skip" — the model can be told to provide a command in
  // tests_run. We still try a trivial exit-code check so we never silently
  // accept a no-verification completion.
  const noop = await runShellCommandTool(
    input.workspaceRoot,
    { cmd: "true", timeoutMs: 5_000 },
    "allow_all",
  );
  if (isForegroundShellResult(noop) && noop.exitCode === 0) {
    return {
      ok: false,
      reason:
        "No terminal-bench /tests/run-tests.sh and no caller-provided verification command was found, and complete_task did not include tests_run. The model must provide a real verification command in complete_task.args.tests_run (or the host must set REAPER_EXTERNAL_VERIFICATION_COMMAND) before this gate accepts completion.",
      commandKind: "skipped",
    };
  }
  return {
    ok: false,
    reason:
      "No verification command could be executed; completion is rejected. The model must provide a real verification command in complete_task.args.tests_run (or the host must set REAPER_EXTERNAL_VERIFICATION_COMMAND) before this gate accepts completion.",
    commandKind: "skipped",
  };
}

function buildOutcome(
  result: Awaited<ReturnType<typeof runVerificationCommand>>,
  commandKind: CompletionVerificationOutcome["commandKind"],
  command: string,
): CompletionVerificationOutcome {
  if (result.ok) {
    return {
      ok: true,
      reason: "Verification command passed.",
      command,
      commandKind,
      outputExcerpt: truncate(result.output ?? result.stdout ?? "", 1500),
    };
  }
  return {
    ok: false,
    reason:
      `Verification command '${command}' failed. The model's complete_task signal is rejected; repair the implementation and rerun verification before re-emitting complete_task. ` +
      `Failure detail: ${truncate(result.output ?? "", 1500)}`,
    command,
    commandKind,
    outputExcerpt: truncate(result.output ?? "", 1500),
  };
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
    }
  }
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

export function renderCompletionGateRejectionFeedback(issues: CompletionValidationIssue[]): string {
  if (issues.length === 0) return "complete_task was rejected by the completion gate.";
  return [
    "Reaper rejected the model's complete_task signal:",
    ...issues.map((issue, index) => `  ${index + 1}. [${issue.code}${issue.field ? `:${issue.field}` : ""}] ${issue.message}`),
    "Re-emit complete_task as the only tool call with a valid summary (>= 20 chars). If the task is not actually done, return concrete repair/check tool calls instead of complete_task.",
  ].join("\n");
}
