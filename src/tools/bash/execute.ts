import type { ChildProcess } from "node:child_process";

import {
  executeBashTool,
  isBackgroundShellResult,
  isForegroundShellResult,
  type ForegroundShellResult,
  type BackgroundShellResult,
  type ShellCommandResult,
} from "../global/bash.js";
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
   * the foreground shell spill is being managed inside `executeBashTool`.
   *
   * Omitting the callback is a no-op: command execution behaves exactly as
   * before and only the final, fully-buffered `BashExecutionResult` is
   * returned. This keeps the existing foreground-spill contract intact while
   * exposing the partial-update channel to interested callers.
   */
  onPartialUpdate?: BashPartialUpdateCallback | undefined;
  /** Raw stdout/stderr chunks for app-server streaming. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void | Promise<void>;
  /**
   * Optional allowlist forwarded to the child environment builder. Names
   * on this list are preserved even when the sensitive-name classifier
   * would otherwise strip them. Default empty.
   */
  childEnvAllowlist?: ReadonlyArray<string>;
  /**
   * Whether the command runs inside this thread's filesystem sandbox.
   * Defaults to on; `false` is the thread's explicit opt-out.
   */
  sandbox?: boolean | undefined;
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

/**
 * Name the file that holds everything the command produced.
 *
 * The tool's in-memory buffer is bounded, so the artifact written after the
 * fact is a slice of the output and not the whole of it. The complete stream is
 * in the process log, which bash writes to as the command runs. Handing the
 * model the complete path is the difference between an analysis of the log and
 * an analysis of the last 256KB of it.
 */
function withFullOutputPointer(
  output: BashOutput,
  result: ForegroundShellResult & { fullOutputPath?: string; fullOutputSize?: number },
): BashOutput {
  if (!result.fullOutputPath) return output;
  return {
    ...output,
    full_output_path: result.fullOutputPath,
    ...(result.fullOutputSize !== undefined ? { full_output_size: result.fullOutputSize } : {}),
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
  // The model-facing timeout is expressed in seconds. Preserve the historical
  // 60-second default for internal and replayed calls that omit it.
  const timeoutMs = Math.max(1, Math.floor((input.timeout ?? 60) * 1000));
  const args = {
    cmd: command,
    timeoutMs,
    ...(description ? { summary: description } : {}),
    ...(input.run_in_background ? { isBackground: true } : {}),
    ...(ctx.sandbox === false ? { sandbox: false } : {}),
  };

  // The bounded accumulator lives for the duration of the call. When
  // `onPartialUpdate` is provided we will at minimum deliver a final
  // snapshot; streaming callers that own the underlying `ChildProcess` can
  // additionally call `attachBashStream(...)` for true partial updates. The
  // accumulator is intentionally created lazily so the no-callback path
  // pays zero allocation overhead.
  const partialAccumulator = ctx.onPartialUpdate ? new BashOutputAccumulator() : undefined;

  const raw: ShellCommandResult = await executeBashTool(
    ctx.workspaceRoot,
    args,
    ctx.safetyProfile,
    ctx.workingDirectory,
    ctx.ruleContext,
    ctx.runtime,
    ctx.childEnvAllowlist ? { allowlist: ctx.childEnvAllowlist } : undefined,
    ctx.onOutput,
  );

  if (isBackgroundShellResult(raw)) {
    return backgroundToBashOutput(raw, ctx.runtime);
  }

  if (!isForegroundShellResult(raw)) {
    throw new Error("Unexpected shell result type");
  }

  let output = toBashOutput(raw);

  /*
   * The process log is the complete output, and it is about to be forgotten.
   *
   * `toBashOutput` maps the shell's `logPath` — the file bash appended every
   * chunk to as the command ran — onto `persisted_output_path`. The block below
   * then overwrites that field with a *second*, bounded file written from the
   * in-memory buffer, because the buffer is capped and cannot hold a large
   * command's output.
   *
   * So the only pointer to the complete output was being replaced by a pointer
   * to a small slice of it, and the notice handed to the model called that
   * slice "full output". Measured on `cat` of a 42MB log: the artifact held
   * 262,112 bytes, the process log held all 42,734,826, and
   * `persisted_output_path` was `undefined` in the result — so a caller could
   * not even reach the 0.62% it claimed to have.
   *
   * The complete path and its true size are captured here, before the
   * overwrite, and travel to the model as `full_output_path` /
   * `full_output_size`.
   */
  const fullOutputPath = output.persisted_output_path;
  const fullOutputSize = raw.persistedOutputSize;

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

  output = withFullOutputPointer(output, {
    ...raw,
    ...(fullOutputPath ? { fullOutputPath } : {}),
    ...(fullOutputSize !== undefined ? { fullOutputSize } : {}),
  });

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
