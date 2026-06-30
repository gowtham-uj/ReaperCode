import type { ToolResult } from "../tools/types.js";
import {
  extractFilePathsFromFailure,
  inferFilesHintFromResults,
  isGeneratedOrBuildPath,
  uniqueStrings,
} from "./file-hints.js";
import {
  classifyDiagnosticCommand,
  deriveRuntimeBlockingFacts,
  describeToolResultTarget,
  getMaxRescueAttemptsPerDiagnostic,
  getMaxRescueStagnantTurns,
  getRepeatedDiagnosticFailure,
  getToolResultCommand,
  getToolResultText,
  hasPlaceholderShellOutput,
  isBuildArtifactRuntimeCommand,
  isBuildCommand,
  isMutatingShellCommand,
  isProducerOrVerificationCommand,
  isSuccessfulStrictVerificationResult,
  isTestCommand,
  isVerificationLikeCommand,
  renderToolResultSnippet,
  stableHash,
  type ExecutionPlanStep,
} from "./engine.js";

// Flagged during extraction: these engine-local helpers were referenced by the
// rescue cluster but were not in the prompt's cross-dependency list. They stay
// in engine.ts and are imported here.
// - getToolResultText: normalizes stdout/stderr/content/error text from a tool result.
// - isBuildCommand/isTestCommand/isVerificationLikeCommand/isBuildArtifactRuntimeCommand: classify diagnostic shell commands.
// - getMaxRescueAttemptsPerDiagnostic/getMaxRescueStagnantTurns: read rescue watchdog environment limits.

export interface RescueWatchdogState {
  attemptsBySignature: Record<string, number>;
  lastSignature?: string;
  lastToolResultCount: number;
  stagnantTurns: number;
  trips: number;
}

interface RuntimeBlockingFacts {
  missingArtifacts: string[];
  failedBuildOrCompile: string[];
  failedRuntimeOrVerification: string[];
  successfulProducerOrVerificationAfterBlocker: boolean;
}

interface RescueDiagnostic {
  kind: "repeated_diagnostic" | "blocked_action" | "runtime_blocker" | "latest_failure";
  signature: string;
  reason: string;
  command?: string;
  errorLogs: string;
  filesHint: string[];
  observedBehavior: string;
  expectedBehavior: string;
  acceptanceCriteria: string[];
  force?: boolean;
}

export function createRescueWatchdogState(): RescueWatchdogState {
  return {
    attemptsBySignature: {},
    lastToolResultCount: 0,
    stagnantTurns: 0,
    trips: 0,
  };
}

export function evaluateRescueWatchdog(input: {
  previous: RescueWatchdogState;
  stepId: string;
  patchRequest?: Record<string, unknown>;
  toolResults: ToolResult[];
  maxAttemptsPerDiagnostic?: number;
  maxStagnantTurns?: number;
}): {
  state: RescueWatchdogState;
  signature: string;
  attempts: number;
  tripped: boolean;
  reason: string;
} {
  const signature = makeRescueWatchdogSignature(input.stepId, input.patchRequest, input.toolResults);
  const newResults = input.toolResults.slice(Math.min(input.previous.lastToolResultCount, input.toolResults.length));
  const madeProgress = newResults.some(isMeaningfulRescueProgressResult);
  const attempts = (madeProgress ? 0 : input.previous.attemptsBySignature[signature] ?? 0) + 1;
  const sameDiagnostic = input.previous.lastSignature === signature;
  const stagnantTurns = sameDiagnostic && !madeProgress ? input.previous.stagnantTurns + 1 : 0;
  const maxAttempts = input.maxAttemptsPerDiagnostic ?? getMaxRescueAttemptsPerDiagnostic();
  const maxStagnantTurns = input.maxStagnantTurns ?? getMaxRescueStagnantTurns();
  const exceededAttempts = attempts > maxAttempts;
  const exceededStagnation = stagnantTurns >= maxStagnantTurns;
  const tripped = exceededAttempts || exceededStagnation;
  const reason = exceededAttempts
    ? `The same rescue diagnostic reached ${attempts} invocation attempts without clearing the blocker (limit ${maxAttempts}).`
    : exceededStagnation
      ? `The same rescue diagnostic produced no meaningful edit, producer, or strict verification progress for ${stagnantTurns} consecutive turn(s) (limit ${maxStagnantTurns}).`
      : "";
  return {
    signature,
    attempts,
    tripped,
    reason,
    state: {
      attemptsBySignature: {
        ...input.previous.attemptsBySignature,
        [signature]: attempts,
      },
      lastSignature: signature,
      lastToolResultCount: input.toolResults.length,
      stagnantTurns,
      trips: input.previous.trips + (tripped ? 1 : 0),
    },
  };
}

function makeRescueWatchdogSignature(stepId: string, patchRequest: Record<string, unknown> | undefined, results: ToolResult[]): string {
  const request = patchRequest ?? {};
  const evidence =
    request.evidence && typeof request.evidence === "object" && !Array.isArray(request.evidence)
      ? (request.evidence as Record<string, unknown>)
      : {};
  const latestFailure = [...results].reverse().find((result) => !result.ok);
  const command =
    typeof evidence.failingCommand === "string"
      ? evidence.failingCommand
      : latestFailure?.name === "bash"
        ? getToolResultCommand(latestFailure)
        : "";
  const diagnosticFamily =
    typeof request.reasonPatchNeeded === "string"
      ? request.reasonPatchNeeded.replace(/\s+/g, " ").trim()
      : latestFailure?.error?.code ?? latestFailure?.name ?? "unknown";
  return stableHash(
    JSON.stringify({
      stepId,
      diagnosticFamily,
      commandClass: classifyDiagnosticCommand(command),
      failureCode: latestFailure?.error?.code ?? "",
    }),
  );
}

function isMeaningfulRescueProgressResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return true;
  if (result.name !== "bash") return false;
  const command = getToolResultCommand(result);
  if (isSuccessfulStrictVerificationResult(result, command)) return true;
  return isMutatingShellCommand(command) || (isProducerOrVerificationCommand(command) && !hasPlaceholderShellOutput(result));
}

function getRescueDiagnostic(input: {
  step: ExecutionPlanStep;
  toolResults: ToolResult[];
  currentBatchFailed: boolean;
}): RescueDiagnostic | undefined {
  const repeated = getRepeatedDiagnosticFailure(input.toolResults);
  if (repeated) {
    return {
      kind: "repeated_diagnostic",
      signature: `repeated:${repeated.signature}`,
      reason:
        "Rescue required: repeated deterministic build/test/runtime diagnostics need a focused problem-solver loop instead of generic repair or replanning.",
      command: repeated.command,
      errorLogs: repeated.errorLogs,
      filesHint: repeated.filesHint,
      observedBehavior: "The same class of diagnostic failure repeated after attempted repair.",
      expectedBehavior: "Pinpoint the root cause, repair the cited source/config/test issue, run the narrowest check successfully, then resume the blocked step.",
      acceptanceCriteria: [
        "State the concrete root-cause hypothesis before repairing.",
        "Repair the cited source/config/test failure with the smallest safe change.",
        "Run the narrowest meaningful build/test/runtime check that exercises the failure.",
        "Do not repeat unchanged failing commands or broad repository reads.",
        "Proceed only after a concrete check passes.",
      ],
    };
  }

  const blocked = findLatestRescuerWorthyBlockedResult(input.toolResults);
  if (blocked) {
    return buildBlockedActionRescueDiagnostic(blocked);
  }

  const facts = deriveRuntimeBlockingFacts(input.toolResults);
  if (hasRuntimeBlockingFacts(facts) && input.currentBatchFailed && hasRescueWorthyRuntimeFacts(facts, input.toolResults)) {
    return buildRuntimeFactsRescueDiagnostic(facts, input.toolResults);
  }

  const latestFailure = findLatestRescuerWorthyFailure(input.toolResults);
  if (latestFailure && input.step.onFailure === "direct_repair") {
    return buildLatestFailureRescueDiagnostic(latestFailure);
  }

  return undefined;
}

function findLatestRescuerWorthyBlockedResult(results: ToolResult[]): ToolResult | undefined {
  return [...results].reverse().find((result) => !result.ok && isRescuerWorthyBlockedResult(result));
}

function isRescuerWorthyBlockedResult(result: ToolResult): boolean {
  if (isTerminalNoProgressBlockedResult(result)) return false;
  const code = result.error?.code ?? "";
  const message = result.error?.message ?? "";
  return /(?:_blocked$|policy_block|path_escape|same_state_failed_action_retry|no_progress_loop|repeated_|stale_write|missing_artifact|sandbox_service|conda_recovery)/i.test(
    `${code}\n${message}`,
  );
}

function isTerminalNoProgressBlockedResult(result: ToolResult): boolean {
  const code = result.error?.code ?? "";
  const message = result.error?.message ?? "";
  return /same_state_failed_action_retry_blocked|repeated_failed_action_blocked|no_progress_loop_blocked|no-progress loop/i.test(
    `${code}\n${message}`,
  );
}

function buildBlockedActionRescueDiagnostic(result: ToolResult): RescueDiagnostic {
  const code = result.error?.code ?? "blocked_action";
  const target = describeToolResultTarget(result);
  const command = result.name === "bash" ? getToolResultCommand(result) : undefined;
  return {
    kind: "blocked_action",
    signature: `blocked:${code}:${stableHash(target || (result.error?.message ?? result.toolCallId))}`,
    reason:
      "Rescue required: normal execution hit a guardrail/blocker showing the current strategy is unsafe, irrelevant, or no longer making progress.",
    ...(command ? { command } : {}),
    errorLogs: renderToolResultSnippet(result),
    filesHint: inferFilesHintFromResults([result]),
    observedBehavior: result.error?.message ?? `Tool '${result.name}' was blocked.`,
    expectedBehavior:
      "Reframe the blocker as a precise problem statement, choose a different legal strategy, fix or recover the underlying issue, verify it with a real check, then resume the parent step.",
    acceptanceCriteria: [
      "Do not retry the blocked action unchanged.",
      "Pinpoint why the action was blocked and what real problem remains.",
      "Use local inspection or web/documentation search only when it can change the repair strategy.",
      "Apply the smallest legal fix or recovery action that addresses the blocker.",
      "Run a narrow real check demonstrating the blocker is gone or the task-facing contract now works.",
    ],
    force: true,
  };
}

function hasRuntimeBlockingFacts(facts: RuntimeBlockingFacts): boolean {
  return facts.missingArtifacts.length > 0 || facts.failedBuildOrCompile.length > 0 || facts.failedRuntimeOrVerification.length > 0;
}

function hasRescueWorthyRuntimeFacts(facts: RuntimeBlockingFacts, results: ToolResult[]): boolean {
  if (facts.missingArtifacts.length > 0 || facts.failedBuildOrCompile.length > 0) return true;
  return results.slice(-8).some((result) => {
    if (result.ok || result.name !== "bash") return false;
    if (isTerminalNoProgressBlockedResult(result)) return false;
    if (isNoDiagnosticShellExitFailure(result)) return false;
    const command = getToolResultCommand(result);
    return isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command) || isBuildArtifactRuntimeCommand(command);
  });
}

function buildRuntimeFactsRescueDiagnostic(facts: RuntimeBlockingFacts, results: ToolResult[]): RescueDiagnostic {
  const filesHint = uniqueStrings([
    ...facts.missingArtifacts,
    ...results
      .slice(-8)
      .filter((result) => !result.ok)
      .flatMap(extractFilePathsFromFailure)
      .filter((file) => !isGeneratedOrBuildPath(file)),
  ]).slice(0, 10);
  return {
    kind: "runtime_blocker",
    signature: `runtime-blocker:${stableHash(JSON.stringify(facts))}`,
    reason:
      "Rescue required: unresolved runtime, build, verification, or missing-artifact facts remain after the current step.",
    errorLogs: JSON.stringify(
      {
        missingArtifacts: facts.missingArtifacts,
        failedBuildOrCompile: facts.failedBuildOrCompile,
        failedRuntimeOrVerification: facts.failedRuntimeOrVerification,
      },
      null,
      2,
    ),
    filesHint,
    observedBehavior: "Recent evidence still contains unresolved blockers without a later successful producer/build/test/check.",
    expectedBehavior:
      "Identify the blocking contract, create or repair the task-facing source/artifact/service/environment, and prove the blocker cleared with command-backed evidence.",
    acceptanceCriteria: [
      "Treat unresolved runtime facts as the current problem statement.",
      "Do not finalize or advance on file existence alone when content/schema/runtime behavior is specified.",
      "Repair the source, artifact producer, service, dependency environment, or test-facing contract that caused the blocker.",
      "Run a narrow command-backed check that would fail if the blocker still existed.",
      "Return patched_and_verified only after the check passes.",
    ],
  };
}

function findLatestRescuerWorthyFailure(results: ToolResult[]): ToolResult | undefined {
  return [...results].reverse().find((result) => !result.ok && isRescuerWorthyFailure(result));
}

function isRescuerWorthyFailure(result: ToolResult): boolean {
  if (isRescuerWorthyBlockedResult(result)) return true;
  if (["replace_in_file", "edit_file", "replace_symbol", "write_file", "sandbox_service_control"].includes(result.name)) {
    return true;
  }
  if (result.name !== "bash") return false;
  if (isTerminalNoProgressBlockedResult(result)) return false;
  if (isNoDiagnosticShellExitFailure(result)) return false;
  const command = getToolResultCommand(result);
  const text = `${command}\n${getToolResultText(result)}`;
  if (isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command) || isBuildArtifactRuntimeCommand(command)) {
    return true;
  }
  return /AssertionError|Traceback|error:|Exception|No such file or directory|not found|timed out|timeout|ModuleNotFoundError|ImportError|Cannot find module|Could not resolve host|NameResolutionError|hash mismatch|expected .* actual|actual .* expected|syntax error|parse error/i.test(
    text,
  );
}

function isNoDiagnosticShellExitFailure(result: ToolResult): boolean {
  if (result.ok || result.name !== "bash") return false;
  const text = getToolResultText(result).replace(/\r/g, "");
  return /^Command exited with code \d+\nCommand: .+\nstdout: <empty>\nstderr: <empty>\s*$/i.test(text);
}

function buildLatestFailureRescueDiagnostic(result: ToolResult): RescueDiagnostic {
  const command = result.name === "bash" ? getToolResultCommand(result) : undefined;
  return {
    kind: "latest_failure",
    signature: `latest:${result.name}:${stableHash(`${command ?? ""}:${getToolResultText(result).slice(0, 1200)}`)}`,
    reason:
      "Rescue required: the current step produced a concrete failing tool result that needs focused diagnosis and repair before normal flow can continue.",
    ...(command ? { command } : {}),
    errorLogs: renderToolResultSnippet(result),
    filesHint: inferFilesHintFromResults([result]),
    observedBehavior: result.error?.message ?? `Tool '${result.name}' failed.`,
    expectedBehavior:
      "Use the latest failing evidence to identify the precise bug/config/environment/service/artifact problem, fix it, run a relevant check, and resume the parent step.",
    acceptanceCriteria: [
      "Pinpoint the current failure from evidence before editing.",
      "Do not retry the same failed action unchanged.",
      "Use targeted local or web documentation search if the failure depends on external tool/library behavior.",
      "Apply the smallest general fix compatible with the visible task contract.",
      "Run the narrowest real check that exercises the repaired behavior.",
    ],
  };
}

export {
  buildBlockedActionRescueDiagnostic,
  buildLatestFailureRescueDiagnostic,
  buildRuntimeFactsRescueDiagnostic,
  findLatestRescuerWorthyBlockedResult,
  findLatestRescuerWorthyFailure,
  getRescueDiagnostic,
  hasRescueWorthyRuntimeFacts,
  hasRuntimeBlockingFacts,
  isMeaningfulRescueProgressResult,
  isNoDiagnosticShellExitFailure,
  isRescuerWorthyBlockedResult,
  isRescuerWorthyFailure,
  isTerminalNoProgressBlockedResult,
  makeRescueWatchdogSignature,
};
export type { RescueDiagnostic, RuntimeBlockingFacts };
