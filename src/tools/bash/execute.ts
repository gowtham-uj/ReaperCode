import type { ChildProcess } from "node:child_process";

import {
  runShellCommandTool,
  isBackgroundShellResult,
  isForegroundShellResult,
  type ForegroundShellResult,
  type BackgroundShellResult,
  type ShellCommandResult,
} from "../global/run-shell-command.js";
import type { SafetyProfile } from "../../policy/rules.js";
import type { RuleEvaluationContext } from "../../policy/rules.js";
import { BASH_INPUT_DEFAULTS } from "./constants.js";
import { persistBashOutput, buildBashResultOutput } from "./result.js";
import { BashOutputAccumulator, type BashPartialUpdateCallback } from "./partial-update.js";
import type { BashInput, BashOutput } from "./schema.js";

export interface BashExecutionContext {
  workspaceRoot: string;
  workingDirectory: string;
  safetyProfile: SafetyProfile;
  ruleContext?: RuleEvaluationContext | undefined;
  runtime: { runId: string; artifactDir: string; toolCallId: string };
  /**
   * Optional streaming sink. When provided, `executeBashCommand` will allocate
   * a bounded `BashOutputAccumulator` and emit throttled partial snapshots
   * via this callback so callers (model layer, TUI) can render progress while
   * the foreground shell spill is being managed inside `runShellCommandTool`.
   *
   * Omitting the callback is a no-op: command execution behaves exactly as
   * before and only the final, fully-buffered `BashExecutionResult` is
   * returned. This keeps the existing foreground-spill contract intact while
   * exposing the partial-update channel to interested callers.
   */
  onPartialUpdate?: BashPartialUpdateCallback | undefined;
}

export interface BashExecutionResult extends BashOutput {
  __backgroundChild?: ChildProcess;
  pid?: number;
}

export function isBackgroundBashResult(result: BashExecutionResult): boolean {
  return typeof result.pid === "number" && Boolean(result.__backgroundChild);
}

export function toForegroundShellResult(output: BashOutput): ForegroundShellResult {
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.exit_code ?? 0,
    wouldBlock: false,
    ...(output.persisted_output_path ? { logPath: output.persisted_output_path } : {}),
  };
}

function toBashOutput(result: ForegroundShellResult): BashOutput {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    interrupted: false,
    ...(result.logPath ? { persisted_output_path: result.logPath } : {}),
    ...(result.persistedOutputSize !== undefined ? { persisted_output_size: result.persistedOutputSize } : {}),
  };
}

function backgroundToBashOutput(result: BackgroundShellResult, runtime: { toolCallId: string }): BashExecutionResult {
  const taskId = result.logPath ?? `bg-${runtime.toolCallId}`;
  return {
    stdout: result.startupOutput?.join("\n") ?? "",
    stderr: "",
    exit_code: null,
    interrupted: false,
    background_task_id: taskId,
    pid: result.pid,
    __backgroundChild: result.child,
  };
}

function emitFinalSnapshot(accumulator: BashOutputAccumulator, callback: BashPartialUpdateCallback | undefined): void {
  if (!callback) return;
  accumulator.finish();
  callback(accumulator.snapshot({ persistIfTruncated: true }));
}

export async function executeBashCommand(
  input: BashInput,
  ctx: BashExecutionContext,
): Promise<BashExecutionResult> {
  const command = input.command;
  const description = input.description;
  // The bash tool has NO DEFAULT TIMEOUT. The model-facing schema
  // requires `timeout` in SECONDS (matching the reference-agent
  // pattern, e.g. pi-mono). We enforce the requirement here too
  // so any internal caller that forgot to set it gets a clear
  // error rather than a silent 60-second fallback.
  if (input.timeout === undefined) {
    throw new Error(
      "bash tool: `timeout` is required (in SECONDS, 1-3600). " +
      "There is no default timeout. The model and all internal callers " +
      "MUST pass an explicit `timeout` on every bash call. " +
      "Suggested values: 60 for short probes, 300 for builds/installs/tests, " +
      "larger for long-running jobs.",
    );
  }
  // The model-facing schema documents `timeout` in SECONDS. Convert
  // to milliseconds for the underlying shell runner.
  const timeoutMs = Math.max(1, Math.floor(input.timeout * 1000));
  const args = {
    cmd: command,
    timeoutMs,
    ...(description ? { summary: description } : {}),
    ...(input.run_in_background ? { isBackground: true } : {}),
  };

  // The bounded accumulator lives for the duration of the call. When
  // `onPartialUpdate` is provided we will at minimum deliver a final
  // snapshot; streaming callers that own the underlying `ChildProcess` can
  // additionally call `attachBashStream(...)` for true partial updates. The
  // accumulator is intentionally created lazily so the no-callback path
  // pays zero allocation overhead.
  const partialAccumulator = ctx.onPartialUpdate ? new BashOutputAccumulator() : undefined;

  const raw: ShellCommandResult = await runShellCommandTool(
    ctx.workspaceRoot,
    args,
    ctx.safetyProfile,
    ctx.workingDirectory,
    ctx.ruleContext,
    ctx.runtime,
  );

  if (isBackgroundShellResult(raw)) {
    return backgroundToBashOutput(raw, ctx.runtime);
  }

  if (!isForegroundShellResult(raw)) {
    throw new Error("Unexpected shell result type");
  }

  let output = toBashOutput(raw);

  const totalChars = (output.stdout?.length ?? 0) + (output.stderr?.length ?? 0);
  if (totalChars > BASH_INPUT_DEFAULTS.PERSIST_THRESHOLD_CHARS) {
    const persisted = await persistBashOutput(output.stdout, output.stderr, ctx.workspaceRoot);
    output = {
      ...output,
      stdout: persisted.stdout,
      stderr: persisted.stderr,
      persisted_output_path: persisted.persistedOutputPath,
      persisted_output_size: persisted.persistedOutputSize,
      head_available: persisted.headAvailable,
      tail_available: persisted.tailAvailable,
    } as BashOutput;
  }

  if (partialAccumulator) {
    partialAccumulator.append(`${output.stdout ?? ""}${output.stderr ? `\n${output.stderr}` : ""}`);
    emitFinalSnapshot(partialAccumulator, ctx.onPartialUpdate);
    await partialAccumulator.closeTempFile();
  }

  return output;
}

export async function bashCommandToModelOutput(
  input: BashInput,
  output: BashOutput,
  workspaceRoot: string,
): Promise<{ content: string; output: BashOutput }> {
  return buildBashResultOutput(input, output, workspaceRoot);
}
