import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir,  readFile,  writeFile } from "node:fs/promises";
import path from "node:path";


import { parseReaperConfig, type ReaperConfig } from "../config/model-config.js";
import { getEngineTunables, runWithConfigTunables } from "../config/config-tunables.js";
import { ReaperConfigSearchPaths, loadReaperConfigFromWorkspace } from "../runtime/workspace-config.js";
import { describeToolResultTarget,  renderStepText,  getToolResultCommand,  isBuildCommand,  isTestCommand,  normalizeVerificationCommand, 
  isVerificationLikeCommand,  hasInlineAssertionOrFailureExit, 
  persistExecutionPlanProgress
} from "./relevance-gate.js";

import {
  inferTransport, extractIntentSummary, makeEvent, splitControlToolCalls,
  persistRunResult, logAssistantMessageTrace, logModelResponseTrace,
} from "./runtime-state.js";
import { clearRunState, getRunState } from "./run-state.js";
import { isReaperDevMode, runWithReaperDevMode } from "./dev-mode.js";
import type { ContextEngineeringHooks } from "./context-engineering-wiring.js";
import { renderToolResultForModel, summarizeToolResult } from "../context/history-compaction.js";
import { executeToolCalls } from "../execution/scheduler.js";
import {
  parseAgentRequestEnvelope,
  type AgentEventEnvelope,
  type AgentRequestEnvelope,
  type TransportKind,
} from "../connection/schemas.js";
import { classifyToolCall } from "../execution/planner.js";
import { resolveEffectivePermissionMode } from "../policy/mode.js";
import { AuditLogger } from "../logging/audit.js";
import { logLangfuseEvent } from "../logging/langfuse.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import { lastEntryId } from "../context/session-journal.js";
import { generateFinalSummary, summarizeExplicitToolRun } from "./final-summary.js";
import { classifyRunFinalStatus, persistRunFailure } from "./run-finalize.js";
import { buildGeneralAgentTools, buildAgentToolDescriptor, userPromptRequestsScratchpad, EMPTY_TOOL_SET, type AgentToolDescriptor } from "./agent-tools.js";
import {
  escapeRegExp, 
  hasSourceMutationShellFragment, 
  isBuildArtifactRuntimeCommand, 
  isCheckLikeShellCommand, 
  parseShellWords, 
  splitUnquotedShellSegments, 
  stripQuotedShellText} from "./shell-parser.js";
import { generateStructuredJson } from "../model/json-response.js";
import type { ModelGateway, ModelRole, ResolvedModelProfile } from "../model/types.js";
import { runWithModelCallContext } from "../model/observability.js";
import { runWithModelCallLogContext } from "../logging/model-call-log.js";
import { appendFailureMemory, loadRecentFailureMemory } from "../recovery/failure-memory.js";
import { commitVerifiedRunKnowledge, loadVerifiedLessons } from "../recovery/verified-memory.js";
import { RecoverySession } from "../recovery/session.js";
import {ToolExecutor} from "../tools/executor.js";
import type { ShellRunner} from "../tools/executor.js";
import type { ToolApprovalRequester } from "../tools/approval.js";
import { runnerAsHooks } from "./hook-bridge.js";
import { AuthoringRuntime } from "../tools/write/authoring-deps.js";
import { HookRunner } from "../extensions/hook-runner.js";
import type {Hooks} from "../adaptive/hooks.js";
import {
  extractFilePathsFromFailure, 
  isGeneratedOrBuildPath, 
  normalizeArtifactPathForMatch, 
  stripWorkspacePrefix, 
  uniqueStrings} from "./file-hints.js";
import {
  createEngineTask as createSessionTask,
  listEngineTasks as listSessionTasks,
  updateEngineTask as updateSessionTask,
  clearEngineTasks as clearSessionTasks,
} from "./task-store.js";
import { getDiscoveredTools, discoverTools, clearDiscoveredTools } from "../tools/discovery.js";
import { toolRegistry, CORE_TOOL_NAMES } from "../tools/registry.js";
import type { CodeModelDescriptor } from "../tools/code/types.js";
import type { CodeModelRunner } from "../tools/code/bridge.js";
import { isKnownToolName, stripUnknownToolArgs } from "./tool-args.js";
import {
  getShellCommandArg} from "./tool-call-utils.js";
import {
  getUnresolvedDiagnosticTarget, 
  isInternalGuardBlockedResult, 
  normalizeDiagnosticCommand} from "./diagnostic-target.js";
import { classifyShellCommandSemantics } from "../tools/command-semantics.js";
import { ToolCallSchema, type ToolCall, type ToolResult } from "../tools/types.js";
import { normalizeToolCall } from "../tools/normalize.js";
import { streamMainAgentResponse } from "./main-agent-node.js";
import type { GenerateRequest } from "../model/types.js";
import { batchNeedsMutationCheckpoint, createCheckpoint } from "./checkpoints.js";
import { getGitDiffState, getGitStatusState, summarizeGitDiffState } from "./diff-state.js";
import {
  classifyVerificationFailure,
  shouldPromoteNonDeterministicFailure,
  type VerificationFailureKind,
} from "../verify/classifier.js";
import { classifyVerificationOutput } from "../verify/failure-classifier.js";
import { runSelfDebugExplanation } from "../verify/judge.js";
import {
  selectVerificationCommand,
  runVerificationCommand,
  classifyGroundedVerificationSignal,
  validateGeneratedVerificationInvariant,
  type VerificationCommand,
  type VerificationGroundedSignal,
} from "../verify/runner.js";
import { detectSemanticFailureText, type SemanticFailureSignal } from "../verify/semantic-failure.js";
import { createVerificationSummary } from "../verify/summary.js";
import { bootPhase0Runtime, type Phase0BootstrapResult } from "./bootstrap.js";
import { prepareRuntimeContent, type ContentPrepResult } from "./content-prep.js";
import { renderContextCockpit, stripCockpitFromMessages, containsCockpitMarker, COCKPIT_OPEN, COCKPIT_CLOSE, CURRENT_REQUEST_MESSAGE_NAME, type CockpitInput } from "./context-cockpit.js";
import { MAIN_AGENT_SYSTEM_PROMPT_TEXT } from "./system-prompt.js";
import { classifyReadFileTrust, markTrust } from "../context/trust.js";
// repo-inspection removed: the engine no longer pre-scans the workspace.
// The model discovers test/build/lint commands itself via grep_search /
// list_package_scripts. See task-contract.ts for the lightweight validation
// hints that replaced the eager scan.
import type { MiddlewareDefinition } from "./middleware.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { redactSecrets } from "../logging/redaction.js";
import { createReaperRunContext, ensureReaperRunContext, writeLatestRunPointer, type ReaperRunContext } from "./run-manager.js";
import { renderFingerprintForPrompt } from "./fingerprint.js";
import { registerCleanup, runWithCleanupScope, installCrashHandlers } from "./cleanup-registry.js";
import { runWithQueryGuard } from "./query-guard.js";
import { emitRuntimeEvent, type RuntimeEventSink, type RuntimeTurnControl } from "./events.js";
import { buildDerivedSecretEncodingFeedback } from "./derived-secret-encoding.js";
import { buildSessionMetricsSummary, countVerificationAttempts, hasPassingVerifyAfterLastEdit } from "./session-metrics.js";
import { collectWorkspaceDiff, runFreshContextDiffReview } from "../verify/diff-review.js";
import { buildRescueHypothesisLedger, renderRescueHypothesisLedger } from "./hypothesis-ledger.js";
import { printContextEvent, printToolCalls, printToolResult, printTurnHeader } from "./session-printer.js";
import { installExtensionTools } from "./extension-wiring.js";
import { validateToolCallBatch, type ToolValidationBlocker } from "./tool-validation.js";
import { getRuntimeDeadlinePressure, type RuntimeDeadlinePressure } from "./deadline-pressure.js";
import { hasRecentIncompleteGeneratedArtifact, hasRecentStructuredResponseFallbackFeedback } from "./generated-artifact-feedback.js";
import { detectBuildLikeTask, extractTaskContract, extractUserIntentText, type TaskContract } from "./task-contract.js";
import {
  applyCandidatePlan, 
  createPlanState, 
  createTodoState, 
  planProgress, 
  setPlanSteps, 
  updateTodoItem, 
  type PlanState, 
  type TodoState} from "./plan-state.js";
import {
  createVerificationState, 
  recordVerificationCheck, 
  type VerificationState} from "./verification-state.js";
import {
  createRescueWatchdogState, 
  isNoDiagnosticShellExitFailure, 
  type RescueWatchdogState, 
  type RuntimeBlockingFacts} from "./rescue-watchdog.js";

export { createRescueWatchdogState, evaluateRescueWatchdog } from "./rescue-watchdog.js";
export type { RescueDiagnostic, RescueWatchdogState, RuntimeBlockingFacts } from "./rescue-watchdog.js";
export {
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
};

export interface RuntimeEngineInput {
  config: unknown;
  workspaceRoot: string;
  requestEnvelope: unknown;
  /** Named session for cross-run continuity; journaled under .reaper/sessions/. */
  namedSession?: string;
  /** Optional user-home override for trusted context and project-trust stores. */
  userHome?: string;
  modelGateway?: ModelGateway;
  abortSignal?: AbortSignal;
  middlewares?: Array<MiddlewareDefinition<unknown>>;
  shellRunner?: ShellRunner;
  hooks?: Hooks;
  eventSink?: RuntimeEventSink;
  turnControl?: RuntimeTurnControl;
  approvalRequester?: ToolApprovalRequester;
  /** Disable direct stdout/stderr model streaming for server-managed turns. */
  writeHumanOutput?: boolean;
  /** Governance role for the caller (main agent = "root"; sub-agents pass
   *  their assigned role). Threaded to the executor's role-policy gate. */
  callerRole?: string;
  /** True when running inside a trusted sandbox (skips high-risk approval). */
  trustedSandbox?: boolean;
  /**
   * Extra instructions for this run, appended after the built-in prompt.
   *
   * Appended, never substituted. The built-in text is the contract the tool
   * schemas, verification loop, and stopping rules are written against; a
   * caller-supplied string that replaced it could quietly remove every one of
   * them, and the run would look identical from the outside until it did
   * something the prompt forbade.
   */
  systemPromptSuffix?: string;
  /**
   * Tool names this run must neither offer the model nor execute.
   *
   * Enforced on both sides of the model: removed from the wire tool list so it
   * is never advertised, and refused at the execution gate so a model that
   * emits the name anyway (from memory, or from an earlier turn's transcript)
   * gets a stated refusal instead of the tool actually running.
   */
  disabledTools?: readonly string[];
}

export interface RuntimeEngineResult {
  state: ReturnType<typeof bootPhase0Runtime>["state"];
  toolResults: ToolResult[];
  assistantMessage: string;
  events: AgentEventEnvelope[];
  trajectoryPath: string;
  contentFingerprint?: string;
  /**
   * Why the run stopped short, when it did. The agent loop raises these, but
   * for a long time nothing downstream read them: they were built, carried in
   * graph state, and dropped on the floor at the result boundary — so a run
   * that failed for a reason the engine knew perfectly well still closed as a
   * successful turn with an empty message. `managed-thread` decides turn status
   * from this field, and the transcript renders what it carries.
   */
  runtimeBlockers?: RuntimeBlocker[];
  notices?: import("./notices.js").Notice[];
  verification?: {
    ok: boolean;
    attemptCount: number;
    retryBudgetConsumed: number;
    command?: string;
	    groundedSignal?: VerificationGroundedSignal;
	    selfDebugExplanation?: string;
	    diffReviewExplanation?: string;
	    failureClasses?: string[];
    feedback?: string[];
    negativeConstraints?: string[];
  };
  orchestration?: {
    ok: boolean;
    completedSubtasks: string[];
    failedSubtasks: Array<{ id: string; reason: string }>;
    conflictSummary?: string;
  };
}

export interface AdvisoryToolCall {
  id: string;
  name: "update_plan" | "update_todo";
  args: Record<string, any>;
}

export interface AdvancementSignalCall {
  id: string;
  name: "advance_step";
  args: { summary: string; evidence?: string[] };
}

export interface SplitToolCalls {
  executableToolCalls: ToolCall[];
  advisoryToolCalls?: AdvisoryToolCall[];
  advancementSignal?: AdvancementSignalCall;
}

export interface ExecutionPlanStep {
  id: string;
  title: string;
  instructions: string;
  suggestedImplementation?: string;
  testGuidance?: string;
  successCriteria?: string[];
  filesHint?: string[];
  commands?: string[];
  advancementEvidence?: string[];
  type?: "inspect" | "command" | "test" | "verify" | "review" | "finalize";
  onFailure?: "direct_repair" | "needs_replan" | "abort";
  tool_calls: ToolCall[];
}

export type PlannerStepType = NonNullable<ExecutionPlanStep["type"]>;



type GraphMode = "explicit_tools" | "needs_model" | "autonomous";
type OrchestrationMode = "general_agent_direct" | "general_agent_orchestrated";

type RuntimeBlocker = {
  source: "progress_guard" | "verification" | "schema" | "tool_validation" | "completion_validation" | "runtime" | "model";
  code: string;
  message: string;
  details?: string[];
};

type GraphState = {
  request?: AgentRequestEnvelope;
  boot?: Phase0BootstrapResult;
  prompt: string;
  mode?: GraphMode;
  orchestrationMode?: OrchestrationMode;
  taskContract?: TaskContract;
  planState: PlanState;
  todoState: TodoState;
  verificationState?: VerificationState;
  runtimeBlockers: RuntimeBlocker[];
  shouldCompact: boolean;
  contentPrep?: ContentPrepResult;
  executionPlan?: ExecutionPlanStep[];
  currentStepIndex: number;
  currentStepToolStartIndex: number;
  completedStepIds: string[];
  rescueWatchdog: RescueWatchdogState;
  plannedToolCalls?: ToolCall[];
  split?: SplitToolCalls;
  toolResults: ToolResult[];
  events: AgentEventEnvelope[];
  assistantMessage: string;
  explicitVerification?: RuntimeEngineResult["verification"];
  feedback: string[];
  negativeConstraints: string[];
  contentFingerprint?: string;
  iteration: number;
  lastBatchFailed: boolean;
  completionGateAttempts: number;
  completionGateExhausted: boolean;
  stuckReplanCount: number;
  readOnlyBatchSignatures: string[];
  needsReplan: boolean;
  done: boolean;
  aborted?: boolean;
  loopCapped?: boolean;
};

type ModelRouteName = keyof ReaperConfig["modelRouting"];




function modelRoute(config: ReaperConfig, route: ModelRouteName): ModelRole {
  return config.modelRouting[route];
}

function runtimeBlockerFromToolValidation(blocker: ToolValidationBlocker): RuntimeBlocker {
  return {
    source: blocker.code === "tool_schema_error" ? "schema" : "tool_validation",
    code: blocker.code,
    message: blocker.message,
    ...(blocker.details?.length ? { details: blocker.details } : {}),
  };
}


function buildRuntimeAgentSystemPrompt(role: string): string {
  const base = "You are a Reaper sub-agent. Emit only valid tool-call JSON. Do not invent tools.";
  if (role === "repair") return `${base} Focus on the smallest concrete fix and validate it.`;
  if (role === "recovery") return `${base} Collapse complexity to the externally visible contract.`;
  return base;
}

function isPlanStepType(value: unknown): value is PlannerStepType {
  return typeof value === "string" && ["command", "review", "inspect", "test", "verify", "finalize"].includes(value);
}
function normalizePlanStepType(type: PlannerStepType, text: string): PlannerStepType {
  // Inspect the step text first. Even when the caller passes a valid
  // explicit type, we re-derive from the text because the planning
  // tests expect the inferred type to take precedence over a stale
  // explicit type ("command" in particular is the most common mistake).
  const inferred = inferPlanStepTypeFromText(text);
  if (inferred !== "command") return inferred;
  return isPlanStepType(type) ? type : "command";
}

/**
 * Heuristically infer the plan step type from the step text when the
 * explicit type is missing or invalid. The keywords are intentionally
 * broad so the existing tests in `tests/unit/planner-step-type.test.ts`
 * exercise the inference path.
 *
 * Priority order: review > verify > test > inspect > finalize > command.
 * The first matching keyword wins. Command is the default fallback.
 */
export function inferPlanStepTypeFromText(text: string): PlannerStepType {
  const lower = text.toLowerCase();
  // Implementation/porting signals take priority over generic "source" /
  // "read" so that "fix", "port", "replace", "implement" become
  // commands even when the text also mentions source code.
  if (/\b(fix|port|replace|implement|patch|convert|build|edit|update|create|write)\b/.test(lower)) {
    // But if the text is overwhelmingly about reading, treat as inspect.
    const readCount = (lower.match(/\b(read|inspect|survey|examine|list)\b/g) ?? []).length;
    if (readCount >= 2) return "inspect";
    return "command";
  }
  if (/\b(review|critique|audit|re-?inspect)\b/.test(lower)) return "review";
  if (/\b(verify|validate|confirm|acceptance|compliance)\b/.test(lower)) return "verify";
  if (/\b(test|pytest|jest|vitest|cargo test|go test|npm test|run.*test)\b/.test(lower)) return "test";
  if (/\b(inspect|read|source|survey|list files|read files|read all)\b/.test(lower)) return "inspect";
  if (/\b(finalize|finalise|commit|wrap up|wrap-up|ship|release)\b/.test(lower)) return "finalize";
  return "command";
}

async function appendSessionTreeMessage(
  logger: TrajectoryLogger,
  input: {
    runId: string;
    sessionId: string;
    message: {
      role: "user" | "assistant" | "tool";
      content: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; name: string; args: unknown }>;
      name?: string;
      is_error?: boolean;
      tool_name?: string;
    };
  },
): Promise<void> {
  const base = {
    event_id: randomUUID(),
    run_id: input.runId,
    session_id: input.sessionId,
    trace_id: input.runId,
    timestamp: new Date().toISOString(),
    log_schema_version: 1 as const,
    level: "info" as const,
  };
  try {
    if (input.message.role === "user") {
      await logger.write({
        ...base,
        kind: "user_message",
        content: input.message.content,
        ...(input.message.name ? { name: input.message.name } : {}),
      });
      return;
    }
    if (input.message.role === "assistant") {
      await logger.write({
        ...base,
        kind: "assistant_message",
        content: input.message.content,
        ...(input.message.tool_calls?.length
          ? {
              tool_names: input.message.tool_calls.map((c) => c.name),
              tool_calls: input.message.tool_calls.map((c) => ({
                id: c.id,
                name: c.name,
                args: c.args ?? {},
              })),
            }
          : {}),
      });
      return;
    }
    // tool result — lands as message role=tool in session.jsonl
    await logger.write({
      ...base,
      kind: "tool_call",
      tool_name: input.message.tool_name ?? input.message.name ?? "tool",
      decision_id: input.message.tool_call_id ?? randomUUID(),
      status: input.message.is_error ? "failed" : "completed",
      is_error: Boolean(input.message.is_error),
      output: input.message.content,
    });
  } catch {
    /* best-effort — never break the run for logging */
  }
}

function hasUnexecutedActionPromise(value: string): boolean {
  const tail = value
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .trim()
    .slice(-1_000);
  if (!tail) return false;
  const action = "(?:create|write|run|apply|edit|verify|check|read|inspect|update|delete|rename|move|install|test)";
  if (new RegExp(`\\b(?:I(?:'ll| will| am going to)|let me)\\s+(?:now\\s+)?${action}\\b`, "i").test(tail)) {
    return true;
  }
  const lastSentence = tail.split(/(?:^|[.!?]\s+)/).at(-1)?.trim() ?? "";
  return /^(?:creating|writing|running|applying|editing|verifying|checking|reading|inspecting|updating|deleting|renaming|moving|installing|testing)\b/i.test(
    lastSentence.replace(/^[`*_~\s]+/, ""),
  ) && !/\b(?:complete|completed|done|fixed|passed|verified|created|wrote|ran)\b/i.test(lastSentence);
}

/**
 * Strip model reasoning envelopes from a final assistant message.
 *
 * Matches the same `<think>...</think>`, `<analysis>...</analysis>`,
 * `<reasoning>...</reasoning>` blocks that `hasUnexecutedActionPromise`
 * strips internally, plus unclosed leading `<think>` tails (some
 * providers omit the closing tag when reasoning runs to the end of the
 * turn). Used at the final-result boundary so the persisted
 * `assistantMessage`, the trajectory `assistant_message` field, and the
 * `finalAssistantTextLength` metric all reflect only user-visible
 * content — internal reasoning stays in trajectory as its own
 * `model_response` events rather than leaking into the summary.
 */
export function stripThinkingBlocks(value: string): string {
  if (!value) return value;
  return value
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    // Unclosed leading reasoning envelope (no closing tag).
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the reasoning text from a model output that embeds it
 * inline as `<think>…</think>`, `<analysis>…</analysis>`, or
 * `<reasoning>…</reasoning>` blocks. Mirror of `stripThinkingBlocks`
 * — used to populate the structured `thinking` trajectory event when
 * a provider returned reasoning inside the visible content instead of
 * via a separate reasoning channel.
 */
export function extractThinkingBlocks(value: string): string {
  if (!value) return "";
  const blocks: string[] = [];
  const re = /<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    blocks.push(m[0]);
  }
  // Unclosed leading envelope — some providers omit the closing tag.
  const unclosed = value.match(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*$/i);
  if (unclosed) blocks.push(unclosed[0]);
  return blocks.join("\n").trim();
}

function hasPassingGroundedVerification(
  toolResults: ToolResult[],
  request: AgentRequestEnvelope,
): boolean {
  const rawVerification = request.payload.verification;
  if (!rawVerification || typeof rawVerification !== "object" || Array.isArray(rawVerification)) return false;
  const requiredCommand = (rawVerification as Record<string, unknown>).command;
  if (typeof requiredCommand !== "string") return false;
  const requiredSignal = classifyGroundedVerificationSignal(requiredCommand);
  if (!requiredSignal.grounded) return false;
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || result.name !== "bash") continue;
    const args = result.args && typeof result.args === "object" && !Array.isArray(result.args)
      ? result.args as Record<string, unknown>
      : {};
    if (typeof args.cmd !== "string") continue;
    const signal = classifyGroundedVerificationSignal(args.cmd);
    if (signal.grounded && signal.kind === requiredSignal.kind) return result.ok;
  }
  return false;
}

/**
 * Observation-based verification for natural stops: the model owns the
 * stop, and the engine never forces a verifier on it. Instead, when the
 * run ends we look at what the model itself ran. If the most recent
 * grounded verification-class command (test > build > typecheck, in the
 * model's own tool history) passed, the run is verified by observation.
 * No declared request.payload.verification is required.
 */
function hasObservedPassingVerification(toolResults: ToolResult[]): boolean {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || result.name !== "bash") continue;
    const args = result.args && typeof result.args === "object" && !Array.isArray(result.args)
      ? result.args as Record<string, unknown>
      : {};
    if (typeof args.cmd !== "string") continue;
    const signal = classifyGroundedVerificationSignal(args.cmd);
    if (!signal.grounded) continue;
    // Only test/build/typecheck runs are authoritative completion
    // evidence; lint/artifact checks alone are not.
    if (!["test", "build", "typecheck"].includes(signal.kind)) continue;
    return result.ok;
  }
  return false;
}

/**
 * Emit the widened `verification.completed` event the introspection panel
 * renders. Only fires when there is something to say: a declared verification
 * result, or a grounded verification-class command in the model's own tool
 * history. A turn that never ran any verifier emits nothing, so the panel
 * stays empty instead of claiming a pass that never happened.
 */
async function emitVerificationCompleted(
  sink: RuntimeEventSink | undefined,
  result: RuntimeEngineResult,
): Promise<void> {
  if (!sink) return;
  const evidence = selectRecentStrictVerificationEvidence(result.toolResults);
  const observedVerified = hasObservedPassingVerification(result.toolResults);
  const declared = result.verification;
  const verified = declared?.ok === true || observedVerified;
  const command = declared?.command ?? evidence?.command;
  const attemptCount = typeof declared?.attemptCount === "number"
    ? declared.attemptCount
    : countVerificationAttempts(result.toolResults);
  const hasSomething = verified || command !== undefined || (declared !== undefined && declared.ok === false);
  if (!hasSomething) return;
  await emitRuntimeEvent(sink, {
    type: "verification.completed",
    ok: declared?.ok ?? observedVerified,
    ...(command !== undefined ? { command } : {}),
    ...(verified ? { verified: true } : {}),
    ...(declared?.groundedSignal
      ? { groundedSignal: declared.groundedSignal }
      : evidence
        ? { groundedSignal: classifyGroundedVerificationSignal(evidence.command) }
        : {}),
    ...(declared?.failureClasses?.length ? { failureClasses: declared.failureClasses } : {}),
    ...(declared?.feedback?.length ? { feedback: declared.feedback } : {}),
    attemptCount,
    ...(declared?.selfDebugExplanation ? { selfDebugExplanation: declared.selfDebugExplanation } : {}),
    ...(declared?.diffReviewExplanation ? { diffReviewExplanation: declared.diffReviewExplanation } : {}),
  });
}

export class RuntimeEngine {
  private readonly config: ReaperConfig;
  private trajectoryLogger: TrajectoryLogger;
  private ctxHooks?: ContextEngineeringHooks;
  /**
   * O(1) membership for the run's tool policy, built once.
   *
   * Every `buildGeneralAgentTools` call and every executed batch consults this,
   * and the second call site runs inside the model loop — rebuilding a `Set`
   * from the array on each iteration would be work proportional to the policy
   * size on every tool call.
   */
  private readonly disabledTools: ReadonlySet<string>;

  /**
   * Dependencies for the three authoring manager tools, built on first use.
   *
   * These were never supplied to the executor at all, so `skill_manager`,
   * `extension_manager`, and `hook_manager` were advertised to the model,
   * promotable by `search_tools`, and then answered every call with "not wired
   * for this run". One per engine, because each caches a registry and a
   * lifecycle that read the workspace's install directories — rebuilding them
   * per turn would re-walk those trees on every tool call.
   */
  private authoringRuntime: AuthoringRuntime | undefined;

  /**
   * The runner approved hooks dispatch through.
   *
   * Shared deliberately between the executor's pre/post-tool gates and
   * `hook_manager`: the manager registers handlers here, and the gates are what
   * fire them. A second runner would accept every registration and dispatch
   * none of them, which reads to the user as "my hook is approved and does
   * nothing".
   */
  private hookRunner: HookRunner | undefined;

  constructor(private readonly input: RuntimeEngineInput) {
    // mergeWorkspaceConfigSync may return `undefined` for an empty
    // workspace with no on-disk config and an unset `input.config`.
    // Hand parseReaperConfig a `{}` rather than `undefined` so the
    // schema error is explicit ("which field is missing?") and the
    // constructor never throws a bare `Cannot read properties of
    // undefined` for callers that want to probe the engine with a
    // partial input (e.g. tests, REPL).
    const mergedConfig = mergeWorkspaceConfigSync(input.config, input.workspaceRoot) ?? {};
    this.config = parseReaperConfig(mergedConfig);
    this.trajectoryLogger = new TrajectoryLogger(input.workspaceRoot, this.config.logging);
    this.disabledTools = input.disabledTools?.length
      ? new Set(input.disabledTools)
      : EMPTY_TOOL_SET;
  }

  /**
   * The authoring deps for this engine, built on first use.
   *
   * `userHome` falls back to `HOME` exactly as the CLI does, so a managed run
   * and a `reaper skills` invocation resolve the same user-global install
   * directory. An empty string is passed through rather than guessed at: the
   * lifecycles join it with `.reaper/skills` and will report a read failure on
   * a path that does not exist, which is truer than silently writing to a
   * directory nobody asked for.
   */
  /**
   * The models a script may call, advertised to `models.list()`.
   *
   * Resolved once per run rather than per call: a script asking what it can
   * reach should get a stable answer, and re-reading the catalog for a value
   * that does not change mid-turn would be a per-call cost for no benefit.
   *
   * `undefined` when the profile cannot be resolved, which leaves `models`
   * unbound inside a script rather than advertising a model that would fail on
   * first use.
   */
  private codeModelCatalogue: readonly CodeModelDescriptor[] | undefined;

  private buildCodeModelRunner(gateway: ModelGateway): CodeModelRunner {
    return async (invocation) => {
      const started = Date.now();
      try {
        /*
         * `source: "code_mode"` rather than `"main_agent"`, and it matters for
         * two reasons. The transcript needs to tell a model call made by a
         * script apart from the turn's own model calls — they are different
         * events with different causes, and a reader seeing only "model call"
         * cannot tell which. And the attention the runtime pays to model calls
         * (retries, context accounting, the token-limit recovery path) is about
         * the turn's own conversation, which a script's call is not part of.
         */
        const result = await gateway.generate({
          role: "main_agent",
          source: "code_mode",
          messages: invocation.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(invocation.system ? { system: invocation.system } : {}),
          ...(invocation.signal ? { signal: invocation.signal } : {}),
        } as never);

        /*
         * The text, and an explicit failure when there is none.
         *
         * `GenerateResult` carries the assistant message and its tool calls
         * together; a script that asked for text and received a tool call has
         * nothing to return, and saying so is better than returning an empty
         * string that reads as "the model said nothing".
         */
        const text = typeof result?.content === "string" ? result.content : "";
        if (!text) {
          return {
            ok: false,
            error: {
              code: "empty_response",
              message: "The model returned no text. Scripts cannot pass tools, so a tool-only response has nothing to hand back.",
            },
            durationMs: Date.now() - started,
          };
        }
        return {
          ok: true,
          text,
          model: result.model || "model",
          durationMs: Date.now() - started,
          ...(result.usage
            ? {
                usage: {
                  ...(result.usage.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
                  ...(result.usage.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
                },
              }
            : {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "model_error",
            message: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - started,
        };
      }
    };
  }

  private getAuthoringRuntime(): AuthoringRuntime {
    if (!this.authoringRuntime) {
      this.authoringRuntime = new AuthoringRuntime({
        workspaceRoot: this.input.workspaceRoot,
        userHome: this.input.userHome ?? process.env.HOME ?? "",
        hookRunner: this.getHookRunner(),
      });
    }
    return this.authoringRuntime;
  }

  /**
   * The one HookRunner for this engine, created on first need.
   *
   * Both the authoring manager and the executor's pre/post-tool gates need the
   * same instance — see the field comment. Creating it lazily keeps a run that
   * touches neither from paying for it.
   */
  private getHookRunner(): HookRunner {
    if (!this.hookRunner) this.hookRunner = new HookRunner();
    return this.hookRunner;
  }

  static shouldHandle(input: RuntimeEngineInput): boolean {
    const request = parseAgentRequestEnvelope(input.requestEnvelope);
    const hasExplicitToolCalls = Array.isArray(request.payload.tool_calls) && request.payload.tool_calls.length > 0;
    return hasExplicitToolCalls || !input.modelGateway || Boolean(input.modelGateway);
  }

  async run(): Promise<RuntimeEngineResult> {
    return runWithConfigTunables(this.config, () =>
      runWithReaperDevMode(this.config.logging?.devMode, () =>
        runWithQueryGuard(() => this.runScoped()),
      ),
    );
  }

  /**
   * Context-window metadata for the context meter: the active model's window
   * when its resolved profile advertises one, plus Reaper's own soft budget.
   * The soft cap is Reaper's ceiling, not the model's — the two differ (a 1M
   * model still runs under a 270k Reaper budget), so the meter shows both.
   */
  private contextWindowInfo(): { modelContextWindow?: number; contextSoftCap?: number } {
    const profile = this.config.models[modelRoute(this.config, "mainAgent")] ?? this.config.models.default_model;
    const window = profile?.capabilities?.maxContextTokens;
    return {
      ...(typeof window === "number" && window > 0 ? { modelContextWindow: window } : {}),
      ...(this.config.contextManagement?.softCap
        ? { contextSoftCap: this.config.contextManagement.softCap }
        : {}),
    };
  }

  private async runScoped(): Promise<RuntimeEngineResult> {
    const startedAt = Date.now();
    // Provider-readiness preflight: fail fast on a missing API key
    // instead of letting the first provider call throw on turn 1 and
    // leave an orphan .reaper/runs/<id>/ on disk. This is a no-op when
    // no model gateway is configured.
    if (this.input.modelGateway) {
      try {
        const profile = await Promise.resolve(this.input.modelGateway.resolveRole("default_model"));
        const { checkProviderProfileReadiness } = await import("../model/preflight.js");
        const readiness = checkProviderProfileReadiness(profile, process.env);
        if (!readiness.ok) {
          const error = new Error(readiness.reason ?? "provider not ready");
          Object.assign(error, { code: "ProviderNotReady", status: 401, provider: readiness.provider, model: readiness.model });
          throw error;
        }
        /*
         * Transport coverage is deliberately *not* checked here. Answering it
         * needs the catalog, and reading the catalog here costs about 2.5s on
         * the first model call of every turn — which is the entire budget
         * between the user pressing Enter and the first streamed token. The
         * client that actually builds the transport already holds the catalog,
         * so the check lives there instead and costs nothing extra.
         */
      } catch (error) {
        if ((error as { code?: string }).code === "ProviderNotReady") throw error;
        // Other errors during preflight (gateway unreachable, schema
        // mismatch) are not the user's missing-API-key case — fall through
        // and let the provider's own first call surface the problem.
      }
    }
    const initialRequest = parseAgentRequestEnvelope(this.input.requestEnvelope);
    const runContext = createReaperRunContext(this.input.workspaceRoot, initialRequest, {
      ...(this.input.namedSession ? { namedSession: this.input.namedSession } : {}),
    });
    await ensureReaperRunContext(runContext, initialRequest);
    await writeLatestRunPointer(this.input.workspaceRoot, runContext);
    clearSessionTasks(runContext.runId);
    clearDiscoveredTools(runContext.runId);
    this.trajectoryLogger = new TrajectoryLogger(this.input.workspaceRoot, { ...this.config.logging, runId: runContext.runId });
    installCrashHandlers();
    // This prefix stays byte-identical for provider prompt caching. The
    // dynamic tool schemas continue to travel in GenerateRequest.tools.
    const systemPromptPrefix = MAIN_AGENT_SYSTEM_PROMPT_TEXT;
    /*
     * A thread's own instructions are appended, so the built-in text remains
     * the exact prefix of every request and the provider's prefix cache still
     * hits on it — appending is the cache-preserving way to add instructions,
     * while rewriting in place would invalidate the cached prefix for that
     * thread on every edit.
     *
     * Computed once per run, like the prefix: the transcript should record one
     * system prompt for the whole turn, not one per model call.
     */
    const systemPrompt = this.input.systemPromptSuffix
      ? `${systemPromptPrefix}\n\n# Thread instructions\n${this.input.systemPromptSuffix}`
      : systemPromptPrefix;
    return runWithCleanupScope(runContext.runDir, () =>
      runWithModelCallLogContext(
        { workspaceRoot: this.input.workspaceRoot, runId: runContext.runId },
        () => runWithModelCallContext(
          {
            workspaceRoot: this.input.workspaceRoot,
            runId: runContext.runId,
            sessionId: runContext.sessionId,
            traceId: runContext.traceId,
            source: "runtime",
            callId: runContext.runId,
            promptPreview: String(initialRequest.payload?.prompt ?? "").slice(0, 500),
            system: systemPrompt,
          },
          async () => {
            await emitRuntimeEvent(this.input.eventSink, {
              type: "turn.started",
              runId: runContext.runId,
              sessionId: runContext.sessionId,
            });
            try {
              const result = await this.runInner({ startedAt, initialRequest, runContext, systemPromptPrefix: systemPrompt });
              // Surface the verification verdict before the turn closes, so the
              // panel already has the classification by the time the transcript
              // marks the turn done. `verified` is the trust-relevant bit:
              // `ok` means the commands exited 0, `verified` means the evidence
              // was grounded in a real test/build/typecheck signal.
              await emitVerificationCompleted(this.input.eventSink, result);
              /*
               * A run that stopped short must not announce itself as completed.
               *
               * The turn status is decided downstream from `runtimeBlockers`,
               * but this event is emitted first and the UI folds it into a
               * finished turn immediately — so emitting it for a failed run
               * makes the transcript flash "completed" and then flip to the
               * error, and a client that only listened for this event would
               * never see the failure at all.
               *
               * Only the blockers that mean "the run did not do what was asked"
               * count. The engine raises advisory blockers for conditions it
               * worked around, and calling those failures would be its own bug.
               */
              const stoppedShort = (result.runtimeBlockers ?? []).some(isStoppedShortBlocker);
              if (!stoppedShort) {
                await emitRuntimeEvent(this.input.eventSink, {
                  type: "turn.completed",
                  runId: runContext.runId,
                  sessionId: runContext.sessionId,
                  assistantMessage: result.assistantMessage,
                });
              }
              return result;
            } catch (error) {
              if (this.input.abortSignal?.aborted) {
                await emitRuntimeEvent(this.input.eventSink, {
                  type: "turn.aborted",
                  runId: runContext.runId,
                  sessionId: runContext.sessionId,
                  reason: String(this.input.abortSignal.reason ?? "aborted"),
                });
              } else {
                const normalized = error instanceof Error ? error : new Error(String(error));
                await emitRuntimeEvent(this.input.eventSink, {
                  type: "turn.failed",
                  runId: runContext.runId,
                  sessionId: runContext.sessionId,
                  error: { name: normalized.name, message: normalized.message },
                });
              }
              throw error;
            } finally {
              this.input.turnControl?.close();
            }
          },
        ),
      ),
    );
  }

  private async runInner(params: {
    startedAt: number;
    initialRequest: AgentRequestEnvelope;
    runContext: ReturnType<typeof createReaperRunContext>;
    systemPromptPrefix: string;
  }): Promise<RuntimeEngineResult> {
    const { initialRequest, runContext, systemPromptPrefix } = params;
    const startedAt = params.startedAt;

    let request: AgentRequestEnvelope | undefined;
    let boot: Phase0BootstrapResult | undefined;
    let recoverySession: RecoverySession | undefined;
    let executor: ToolExecutor | undefined;
    let auditLogger: AuditLogger | undefined;

    const getRequest = () => {
      if (!request) throw new Error("LangGraph runtime request was not bootstrapped");
      return request;
    };
    const getBoot = () => {
      if (!boot) throw new Error("LangGraph runtime state was not bootstrapped");
      return boot;
    };
    const getExecutor = () => {
      if (!executor) throw new Error("LangGraph runtime executor was not bootstrapped");
      return executor;
    };
    const getAuditLogger = () => {
      if (!auditLogger) throw new Error("LangGraph runtime audit logger was not bootstrapped");
      return auditLogger;
    };
    const getRecoverySession = () => {
      if (!recoverySession) throw new Error("LangGraph runtime recovery session was not bootstrapped");
      return recoverySession;
    };

    const bootstrapNode = async () => {
      request = { ...initialRequest, session_id: runContext.sessionId, trace_id: runContext.traceId };
      const prompt = typeof request.payload.prompt === "string" ? request.payload.prompt : "Execute requested coding task";
      const hasExplicitToolCalls = Array.isArray(request.payload.tool_calls) && request.payload.tool_calls.length > 0;

      boot = bootPhase0Runtime({
        config: this.config,
        transport: inferTransport(request.metadata.transport),
        requestEnvelope: request,
        workspaceRoot: this.input.workspaceRoot,
        userIntentSummary: extractIntentSummary(request),
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        traceId: runContext.traceId,
        ...(this.input.namedSession ? { namedSession: this.input.namedSession } : {}),
      });
      const mode: GraphMode = hasExplicitToolCalls ? "explicit_tools" : this.input.modelGateway ? "autonomous" : "needs_model";

      recoverySession = new RecoverySession({
        workspaceRoot: this.input.workspaceRoot,
        runId: boot.state.runId,
        sessionId: boot.state.sessionId,
        traceId: boot.state.runId,
        logLevel: boot.state.logLevel,
        trajectoryLogger: this.trajectoryLogger,
      });
      auditLogger = new AuditLogger(this.input.workspaceRoot, { runId: boot.state.runId });

      const hookForwarder = runnerAsHooks(this.getHookRunner());

      /*
       * The model a script will reach by default, and the only one advertised.
       *
       * One entry, not the whole catalog. A script calling a model is asking
       * *this thread* to think — it is not a model picker, and offering every
       * model the user has configured would invite a script to run on a
       * provider the thread never chose, with credentials resolved for a
       * profile nobody selected. The turn already decided which model is
       * running; `models.call()` uses that one, and `models.list()` says so
       * honestly rather than advertising reach the script does not have.
       */
      if (this.input.modelGateway) {
        try {
          const profile = await this.input.modelGateway.resolveRole("default_model");
          this.codeModelCatalogue = [
            {
              id: `${profile.provider}/${profile.model}`,
              provider: profile.provider,
              model: profile.model,
              ...(profile.capabilities?.maxContextTokens
                ? { contextTokens: profile.capabilities.maxContextTokens }
                : {}),
            },
          ];
        } catch {
          // Unresolvable profile: leave the surface unbound rather than
          // advertising a model that would fail on first use.
          this.codeModelCatalogue = undefined;
        }
      }

      executor = new ToolExecutor({
        workspaceRoot: this.input.workspaceRoot,
        runId: boot.state.runId,
        sessionId: boot.state.sessionId,
        traceId: boot.state.runId,
        logLevel: boot.state.logLevel,
        safetyProfile: boot.state.safetyProfile,
        permissionMode: resolveEffectivePermissionMode(getEngineTunables().permissionMode),
        // Governance wiring (V4): the main agent runs as "root" (governed by
        // classifier + hard-deny rules); sub-agents pass their assigned role
        // through the ToolExecutorOptions so the role-policy engine applies.
        ...(this.input.callerRole ? { callerRole: this.input.callerRole } : {}),
        ...(this.input.trustedSandbox ? { trustedSandbox: this.input.trustedSandbox } : {}),
        ...(this.config?.security?.childEnvAllowlist ? { childEnvAllowlist: this.config.security.childEnvAllowlist } : {}),
        recoverySession,
        config: this.config,
        trajectoryLogger: this.trajectoryLogger,
        auditLogger,
        runDir: runContext.runDir,
        artifactsDir: runContext.artifactsDir,
        ...(this.input.shellRunner ? { shellRunner: this.input.shellRunner } : {}),
        ...(this.input.eventSink ? { eventSink: this.input.eventSink } : {}),
        ...(this.input.approvalRequester ? { approvalRequester: this.input.approvalRequester } : {}),
        ...(this.input.abortSignal ? { abortSignal: this.input.abortSignal } : {}),
        // Passed even when empty: the executor's own default is "nothing is
        // disabled", so omitting it would be identical — but threading the
        // engine's set through explicitly keeps the tool surface the model is
        // offered and the tool surface the executor honours the same value
        // rather than two values that happen to agree.
        disabledTools: this.disabledTools,
        // The three authoring managers dispatch through this. Their handlers
        // and the executor switch that calls them were both written and both
        // tested; the option that joins them was never supplied by any caller,
        // so all three tools threw "not wired for this run" on every call since
        // they were added. Nothing caught it earlier because each layer was
        // correct in isolation and no test stood at the join.
        authoringTools: this.getAuthoringRuntime().build(),
        /*
         * The registry extension tools are dispatched from, and the callback
         * that refills it.
         *
         * Both were missing, which made `enable_extension` a dead end: the
         * extension's tools were registered on the manager's own registry and
         * activated, and the executor — the only thing that dispatches a tool
         * call — never learned they existed. `installExtensionTools` then tried
         * to copy them across by reading a field `ToolExecutor` does not have,
         * so it copied zero and reported success.
         *
         * `extensionToolRegistry()` builds the registry lazily, so this costs
         * nothing until an extension actually exists. The refresh callback is
         * what `enable` calls to push a newly activated extension's tools in
         * without waiting for the next run.
         */
        ...(this.getAuthoringRuntime().extensionToolRegistry()
          ? { extensionTools: this.getAuthoringRuntime().extensionToolRegistry()! }
          : {}),
        refreshExtensionTools: () => {
          /*
           * `executor` is assigned from this very constructor call, so by the
           * time anything can invoke this callback it is set. The guard is not
           * defensive padding: it is what makes that reasoning legible to the
           * type checker and to the next reader, rather than an assertion that
           * happens to hold.
           */
          if (!executor) return;
          const runtime = this.getAuthoringRuntime();
          const manager = runtime.extensionRegistry();
          if (!manager || !runtime.extensionToolRegistry()) return;
          installExtensionTools({ executor, registry: manager });
        },
        /*
         * The models a Code Mode script may call.
         *
         * Supplied unconditionally when a gateway exists, because the surface
         * is not opt-in: the model decides whether a script that orchestrates
         * model calls is the right answer, and it cannot make that decision
         * about a capability it does not have. The runner closes over the same
         * gateway the turn itself is using, so a script's call carries this
         * turn's resolved credentials and role rather than reaching for a
         * second configuration that could disagree with it.
         */
        ...(this.input.modelGateway
          ? { codeModelRunner: this.buildCodeModelRunner(this.input.modelGateway) }
          : {}),
        ...(this.codeModelCatalogue ? { codeModels: this.codeModelCatalogue } : {}),
        // The other half of the same gap. The executor's PreToolUse /
        // PostToolUse / PreSkillInvoke gates all read `options.hooks`, and
        // nothing ever set it — so an approved hook was registered on a runner
        // that no gate consulted, and fired for nothing. This forwards the
        // gates to the same runner the authoring manager writes to, and unlike
        // the extension bus's fan-out it keeps the veto: an `enforce: true`
        // hook is exactly the hook whose answer must not be discarded.
        ...(hookForwarder ? { hooks: hookForwarder } : {}),
      });

      // Run-boundary metadata: resolve which provider + model the
      // mainAgent route lands on so external harnesses reading the
      // event stream know what actually ran without joining configs.
      const mainProfile = this.config.models[modelRoute(this.config, "mainAgent")] ?? this.config.models.default_model;
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: boot.state.runId,
        session_id: boot.state.sessionId,
        trace_id: boot.state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "session_start",
        level: boot.state.logLevel,
        user_intent_summary: boot.state.userIntentSummary,
        provider: mainProfile?.provider ?? "unknown",
        model: mainProfile?.model ?? "unknown",

        run_params: {
          workspace_root: this.input.workspaceRoot,
          safety_profile: boot.state.safetyProfile,
          log_level: boot.state.logLevel,
          ...(boot.state.namedSession ? { named_session: boot.state.namedSession } : {}),
          ...(typeof mainProfile?.defaultParams?.maxTokens === "number"
            ? { max_tokens: mainProfile.defaultParams.maxTokens }
            : {}),
          ...(typeof mainProfile?.defaultParams?.temperature === "number"
            ? { temperature: mainProfile.defaultParams.temperature }
            : {}),
          ...(boot.state.tokenBudget?.softCap ? { token_soft_cap: boot.state.tokenBudget.softCap } : {}),
        },
      });

      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: boot.state.runId,
        session_id: boot.state.sessionId,
        trace_id: boot.state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: boot.state.logLevel,
        from_step: "Start",
        to_step: "Content Prep",
      });

      const [failureMemory, verifiedLessons] = await Promise.all([
        loadRecentFailureMemory(this.input.workspaceRoot, 4).catch(() => []),
        loadVerifiedLessons(this.input.workspaceRoot, prompt, 4).catch(() => []),
      ]);
      const initialFeedback = failureMemory.length || verifiedLessons.length
        ? [
            [
              "Relevant prior reliability lessons for this workspace:",
              ...verifiedLessons.map((item) => `- ${item}`),
              ...failureMemory.map((item) => `- ${item}`),
              "Use these as generic failure-pattern memory. Do not copy prior task answers; apply only the repair strategy and do-not-repeat constraints when they fit current evidence.",
            ].join("\n"),
          ]
        : [];

      return {
        request,
        boot,
        prompt,
        mode,
        planState: createPlanState(),
        todoState: createTodoState(),
        toolResults: [],
        events: [],
        assistantMessage: "",
        runtimeBlockers: [],
        feedback: initialFeedback,
        negativeConstraints: [],
        iteration: 0,
        currentStepIndex: 0,
        currentStepToolStartIndex: 0,
        completedStepIds: [],
        rescueWatchdog: createRescueWatchdogState(),
        lastBatchFailed: false,
        completionGateAttempts: 0,
        completionGateExhausted: false,
        shouldCompact: false,
        stuckReplanCount: 0,
        readOnlyBatchSignatures: [],
        needsReplan: false,
        done: false,
      } satisfies Partial<GraphState>;
    };

    const extractTaskContractNode = async (state: GraphState) => {
      const taskContract = extractTaskContract(state.prompt);
      const verificationState = createVerificationState(taskContract.likelyValidation);
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: "Bootstrap",
        to_step: "Extract Task Contract",
      });
      return { taskContract, verificationState } satisfies Partial<GraphState>;
    };

    const contentPrepNode = async (state: GraphState) => {
      if (state.mode === "needs_model") return {};
      const prePrepShouldCompact = shouldRunCompaction({
        prompt: state.prompt,
        toolResults: state.toolResults,
        softCap: getBoot().state.tokenBudget.softCap,
      });
      const prepared = await prepareRuntimeContent({
        workspaceRoot: this.input.workspaceRoot,
        ...(this.input.userHome ? { userHome: this.input.userHome } : {}),
        prompt: state.prompt,
        maxContextTokens: Math.max(2000, Math.floor(getBoot().state.tokenBudget.softCap * 0.1)),
        compactToolResults: prePrepShouldCompact,
        forceIndexRefresh: state.iteration === 0,
        prunerConfig: this.config.pruner,
        toolResults: state.toolResults,
        backgroundProcesses: getExecutor().getBackgroundProcesses(),
        ...(this.input.middlewares ? { middlewares: this.input.middlewares as any } : {}),
      });
      if (prepared?.toolShortlist?.length) {
        discoverTools(prepared.toolShortlist.map((t) => t.name), getBoot().state.runId);
      }
      const budget = calculateContextBudget({
        prompt: state.prompt,
        toolResults: state.toolResults,
        preparedContextTokens: prepared.preparedContext.usedTokens,
      });
      const shouldCompact = prePrepShouldCompact || budget.totalTokens >= getBoot().state.tokenBudget.softCap;
      await logContextBudget({
        workspaceRoot: this.input.workspaceRoot,
        runId: getBoot().state.runId,
        sessionId: getBoot().state.sessionId,
        traceId: getBoot().state.runId,
        budget,
        softCap: getBoot().state.tokenBudget.softCap,
        compacted: shouldCompact,
      });
      return {
        contentPrep: prepared,
        contentFingerprint: prepared.preparedContext.fingerprint,
        orchestrationMode: classifyOrchestrationMode(state.prompt, prepared),
        shouldCompact,
      };
    };

    const mainAgentNode = async (state: GraphState) => {
      const runState = getRunState(getBoot().state.runId);
      // Context-engineering wiring: boot, before-model-call, after-model-call,
      // after-tool-result, provider-token-limit-error, run-complete.
      //
      // Build the LLM-based inference callback used by full-summarization.
      // The wiring calls this with the canonical 9-section summarization
      // prompt; we route it through the SAME gateway the engine uses for
      // the main agent, with `stream: false`, the "summarizer" role, and
      // a high maxTokens ceiling (so the LLM can produce the full summary
      // without hitting the per-turn cap).
      let ctxHooks: ContextEngineeringHooks | undefined = this.ctxHooks;
      if (!ctxHooks) {
        // The full-summarizer runs OUT-OF-BAND via `fetch` against the
        // summarizer-profile endpoint. It does NOT touch the engine's
        // stream buffer, so there's zero recursion risk. See
        // `context/full-summary-inference.ts` for the design.
        const { createContextEngineeringHooks } = await import("./context-engineering-wiring.js");
        const { inferFullSummary } = await import("../context/full-summary-inference.js");
        const inferSummariser = async (prompt: string): Promise<string> => {
          return await inferFullSummary(prompt, {
            config: this.config,
            workspaceRoot: this.input.workspaceRoot,
            runId: getBoot().state.runId,
            summaryTimeoutMs: 240_000, // 4-minute ceiling per spec
          });
        };
        ctxHooks = createContextEngineeringHooks({
          infer: inferSummariser,
          /*
           * One `context.updated` per technique, straight through to the same
           * sink every other runtime event uses. The wiring knows which
           * technique ran and how much it reclaimed; the engine only ever saw
           * the aggregate return value, which is why this is emitted from
           * there rather than reconstructed here.
           */
          onContextEvent: (event) => {
            void emitRuntimeEvent(this.input.eventSink, { type: "context.updated", ...event });
            // The terminal has no event sink to subscribe to, so the same
            // callback drives it directly. Both surfaces are fed from one
            // place, which is what keeps their wording from drifting.
            printContextEvent(event);
            /*
             * Append-only accounting, in the session's own record.
             *
             * The transcript is per-turn and the events are transient; a
             * session that runs for days needs a durable line saying what
             * happened to its context and when, and it must be readable after
             * the fact — a user asking "why does the agent not remember the
             * first hour" should be able to see that a summary ran and what it
             * reclaimed. Written here rather than in the wiring because the
             * workspace and session live in this scope, and because a failure
             * to write must never affect the run.
             */
            if (event.phase === "completed" && ((event.savedChars ?? 0) > 0 || (event.savedTokens ?? 0) > 0)) {
              void (async () => {
                try {
                  const { recordCompactionSavings } = await import("../context/session-journal.js");
                  await recordCompactionSavings(this.input.workspaceRoot, {
                    ts: Date.now(),
                    session: getBoot().state.sessionId,
                    kind: event.technique,
                    savedChars: event.savedChars ?? 0,
                    ...(event.savedTokens !== undefined ? { savedTokens: event.savedTokens } : {}),
                    ...(event.messagesBefore !== undefined ? { cleared: event.messagesBefore } : {}),
                    ...(event.softCap !== undefined ? { contextWindow: event.softCap } : {}),
                    ...(event.usedTokens !== undefined && event.softCap
                      ? { ratio: event.usedTokens / event.softCap }
                      : {}),
                    ...(event.detail !== undefined ? { detail: event.detail } : {}),
                  });
                } catch {
                  /* never let accounting break a run */
                }
              })();
            }
          },
          config: this.config as { models?: unknown } as any,
          // Prefer last provider-reported input tokens as a floor so
          // shake/full-summary gates track real usage, not only chars/4.
          // Avoids the previous JSON.stringify(msgs).length per-call cost
          // by summing message-content lengths in a single pass — the
          // chat-4o rule of thumb (chars/4) is just an estimate; the
          // provider-reported number is more accurate.
          countTokens: (msgs: unknown[]) => {
            let chars = 0;
            if (Array.isArray(msgs)) {
              for (const m of msgs) {
                if (m === null || typeof m !== "object") continue;
                const content = (m as { content?: unknown }).content;
                if (typeof content === "string") {
                  chars += content.length;
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
                      chars += (block as { text: string }).text.length;
                    }
                  }
                }
              }
            }
            const charsEst = Math.ceil(chars / 4);
            const last = runState.lastInputTokens;
            if (typeof last === "number" && Number.isFinite(last) && last > 0) {
              return Math.max(charsEst, Math.floor(last));
            }
            return charsEst;
          },
        });
        this.ctxHooks = ctxHooks;
      }

      const bootNamedSession = getBoot().state.namedSession;
      await ctxHooks.onBoot({
        workspaceRoot: this.input.workspaceRoot,
        runId: getBoot().state.runId,
        sessionId: getBoot().state.sessionId,
        ...(bootNamedSession ? { namedSession: bootNamedSession } : {}),
      }).catch(() => undefined);

      if (!this.input.modelGateway || !state.contentPrep) return {};


      const allGeneralAgentTools = buildGeneralAgentTools(getDiscoveredTools(getBoot().state.runId), this.disabledTools);
      const generalAgentTools = selectGeneralAgentToolsForTurn({
        request: getRequest(),
        state,
        tools: allGeneralAgentTools,
      });

      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: state.iteration === 0 ? "Content Prep" : "Runtime Blockers",
        to_step: "Main Agent",
      });

      /*
       * Declared outside the `try` because the `catch` sets it too: a model
       * call that throws has to become a blocker just like one that returns
       * nothing three times running. Inside the block it was unreachable from
       * the handler, which is part of why that path reported success.
       */
      let terminalRuntimeBlocker: RuntimeBlocker | undefined;
      try {
        printTurnHeader(state.iteration + 1);
        // reference-style live-execution loop: stream a model turn, fire any
        // completed streamed tool calls as soon as the deltas assemble, then
        // immediately feed the tool result back into the next model call
        // (resuming in the same Main Agent visit). Loop until the model
        // emits a stop (no tool calls, terminal text) or a hard budget
        // exhausts. The engine's downstream nodes only see the final
        // accumulated `toolResults`, never the per-tool dispatch latency.
        const liveToolResults: ToolResult[] = [];
        const liveEvents: AgentEventEnvelope[] = [];
        let lastAssistantMessage = "";
        let liveModelTurnIndex = 0;
        let incompleteRecoveryAttempts = 0;
        let emptyStopRetries = 0;
        let prematureStopNudges = 0;
        const EMPTY_STOP_MAX_RETRIES = 3;
        const PREMATURE_STOP_MAX_NUDGES = 2;
        const rawPromptValue = getRequest().payload.prompt;
        const rawUserPrompt = typeof rawPromptValue === "string" ? rawPromptValue : "";
        let currentRequestLogged = false;
        // Pi-style: conversation continuity comes from session.jsonl message
        // tree via onBoot → buildActiveBranchMessages. No live-conversation.json.
        const liveConversation: GenerateRequest["messages"] = [];
        {
          const resumeSlot = runState.sessionResume;
          const resume = resumeSlot?.resume;
          const reAnchor =
            resume && typeof resume.reAnchor === "string" ? resume.reAnchor.trim() : "";
          const rehydratedMessages =
            resume && Array.isArray(resume.rehydratedMessages)
              ? resume.rehydratedMessages.filter(
                  (msg: unknown) =>
                    msg &&
                    typeof msg === "object" &&
                    typeof (msg as { role?: unknown }).role === "string",
                )
              : [];
          if (resume && (reAnchor.length > 0 || rehydratedMessages.length > 0)) {
            const resumeMessages: unknown[] = [];
            if (reAnchor.length > 0) {
              resumeMessages.push({ role: "user", content: reAnchor });
            }
            resumeMessages.push(...(rehydratedMessages as unknown[]));
            liveConversation.push(...(resumeMessages as any[]));
            runState.rehydratedCount = resumeMessages.length;
            runState.sessionResume = undefined;
            try {
              const named = getBoot().state.namedSession;
              if (named) {
                runState.journalLeafId = lastEntryId(this.input.workspaceRoot, named);
              }
            } catch {
              /* best-effort */
            }
            await this.trajectoryLogger.write({
              event_id: randomUUID(),
              run_id: getBoot().state.runId,
              session_id: getBoot().state.sessionId,
              trace_id: getBoot().state.runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "assistant_message",
              level: getBoot().state.logLevel,
              content: `[session-resume] prepended re-anchor (${resume.stats?.recentTurns ?? 0} turns, ${resume.stats?.summariesAvailable ?? 0} summaries)`,
            }).catch(() => undefined);
          }
        }

        // ─── Context-engineering: APPLY STASHED FULL-SUMMARY ─────────────
        // OMP port: when a background full-summary completes during the
        // run, the wiring stashes the post-compact messages on a
        // per-runId slot. Apply them here BEFORE the first model call
        // (or after resume) so the summary actually replaces the older
        // context — same effect as OMP's `replaceMessages()` after a
        // compaction. Without this, the wiring would compute the
        // replacement and never use it.
        const SUMMARY_STALE_MS = 30_000;
        const appliedSlot = getRunState(runContext.runId).fullSummaryApplied;
        if (appliedSlot && appliedSlot.messages && Array.isArray(appliedSlot.messages) && appliedSlot.messages.length > 0) {
          const ageMs = Date.now() - (appliedSlot.appliedAt ?? 0);
          if (ageMs <= SUMMARY_STALE_MS) {
            await this.trajectoryLogger.write({
              event_id: randomUUID(),
              run_id: runContext.runId,
              session_id: getBoot().state.sessionId,
              trace_id: runContext.runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "state_transition",
              level: getBoot().state.logLevel,
              from_step: "Content Prep",
              to_step: "Summary Replaced",
            });
            replaceConversationMessages(liveConversation, appliedSlot.messages as any[]);
            getRunState(runContext.runId).fullSummaryApplied = undefined;
            await this.trajectoryLogger.write({
              event_id: randomUUID(),
              run_id: runContext.runId,
              session_id: getBoot().state.sessionId,
              trace_id: runContext.runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "assistant_message",
              level: getBoot().state.logLevel,
              content: `[summary-applied] replaced ${appliedSlot.messages.length} post-compact message(s) at start of run (age=${ageMs}ms)`,
            });
          } else {
            // Stale: drop without applying.
            getRunState(runContext.runId).fullSummaryApplied = undefined;
          }
        }
        const latestVerificationBlocker = [...state.runtimeBlockers]
          .reverse()
          .find((blocker) => blocker.source === "verification" && blocker.code === "verification_failed");
        if (latestVerificationBlocker) {
          const feedbackMessage = `[Runtime verification failed]\n${latestVerificationBlocker.message}`;
          const alreadyPresent = liveConversation
            .slice(-12)
            .some((message) => message.role === "user" && message.content === feedbackMessage);
          if (!alreadyPresent) {
            liveConversation.push({ role: "user", content: feedbackMessage });
          }
        }

        const softCap = getBoot().state.tokenBudget?.softCap ?? 270_000;

        // Plan/todo working state for the live loop. The graph's
        // queue_results/validate_tool_calls nodes only run on the
        // non-autonomous (explicit_tools) path, so the autonomous live
        // loop maintains plan/todo + advancement state itself (R1/R2):
        // `update_plan`/`update_todo` merge here; `advance_step` is
        // recorded as a progress signal and fed back as an advisory tool
        // result so the model sees its control calls were honored.
        let livePlanState = state.planState;
        let liveTodoState = state.todoState;
        let liveAdvancementEvidence: string[] = [];
        let liveAborted = false;

        // R3: hard bound on the live loop. The model owns the stop
        // decision, but a model that keeps emitting tool_calls (or keeps
        // hitting retry re-prompts) must not spin forever. Honoring the
        // configured `langgraphRecursionLimit` gives operators a real cap.
        const liveIterationLimit = getGraphRecursionLimit();
        let liveIteration = 0;

        while (liveIteration < liveIterationLimit) {
          liveIteration += 1;
          const ctxCallStartedAt = Date.now();

          // ─── Context-engineering: BEFORE-MODEL-CALL (per-iteration) ───
          // Re-evaluate shake/summary/time-MC thresholds on every model
          // call. Tool messages appended since the previous iteration may
          // have grown the conversation past the softCap — only an
          // inner-loop check has up-to-date state.
          try {
            const liveSoftCap = softCap;
            const beforeMcInner = await ctxHooks.onBeforeModelCall({
              workspaceRoot: this.input.workspaceRoot,
              runId: getBoot().state.runId,
              sessionId: getBoot().state.sessionId,
              traceId: getBoot().state.runId,
              messages: liveConversation,
              softCap: liveSoftCap,
              trajectoryLogger: this.trajectoryLogger,
            });
            if (Array.isArray(beforeMcInner.messages)) {
              replaceConversationMessages(liveConversation, beforeMcInner.messages as any[]);
            }
          } catch { /* swallow */ }

          // ─── OMP port: detect #21 promote-context-model and swap
          //   the active mainAgent role to a sibling with strictly
          //   larger context. OMP's runAutoCompaction does this BEFORE
          //   compacting — a long-running loop that would otherwise
          //   compact the history gets a fresh window instead. The
          //   wiring records promotions via `recordPromotion(workspaceRoot, {toRole, toProfile, ...})`.
          //   We use `p.toRole` (canonical role name) directly to swap
          //   the `turnRequest.role` — this works even when both
          //   profiles use the same model id (the previous lookup by
          //   `model === toProfile` failed in that case).
          let effectiveMainAgentRole = modelRoute(this.config, "mainAgent");
          try {
            // Cache the module so the dynamic import resolves cleanly.
            // (A parenthesized `(await import(...)).readRecentPromotions(...)`
            // pattern has been observed to evaluate to `undefined` under
            // tsx's ESM-transpile path on some runtimes. Use destructuring
            // which works consistently with both the engine and wiring.)
            const { readRecentPromotionsSync: readProms } = await import("../context/promotions.js");
            const promotions = readProms(
              this.input.workspaceRoot,
              getBoot().state.runId,
              1,
            );
            if (promotions.length > 0) {
              const p = promotions[0]!;
              // Validate the role against the schema's accepted set.
              // Legacy role names like "main_reasoner" are accepted
              // by ModelRoleInputSchema and resolved to canonical.
              const { ModelRoleInputSchema } = await import("../model/types.js");
              const targetRole = ModelRoleInputSchema.safeParse(p.toRole);
              if (
                targetRole.success &&
                typeof targetRole.data === "string" &&
                (modelRoute(this.config, "mainAgent") as string) !== targetRole.data
              ) {
                effectiveMainAgentRole = targetRole.data as any;
                await this.trajectoryLogger.write({
                  event_id: randomUUID(),
                  run_id: getBoot().state.runId,
                  session_id: getBoot().state.sessionId,
                  trace_id: getBoot().state.runId,
                  timestamp: new Date().toISOString(),
                  log_schema_version: 1,
                  kind: "state_transition",
                  level: getBoot().state.logLevel,
                  from_step: "Content Prep",
                  to_step: `Promoted: role=${targetRole.data} (${p.toContextTokens} ctx, from=${p.fromRole})`,
                });
              } else if (!targetRole.success) {
                await this.trajectoryLogger.write({
                  event_id: randomUUID(),
                  run_id: getBoot().state.runId,
                  session_id: getBoot().state.sessionId,
                  trace_id: getBoot().state.runId,
                  timestamp: new Date().toISOString(),
                  log_schema_version: 1,
                  kind: "state_transition",
                  level: getBoot().state.logLevel,
                  from_step: "Content Prep",
                  to_step: `Promoted (no role match): ${p.toProfile} (${p.toContextTokens} ctx) — toRole='${p.toRole}' not a valid ModelRole`,
                });
              }
            }
          } catch { /* best-effort */ }

          // Tool discovery is live: search_tools and content-prep promotions
          // must update both the API schemas and the system inventory on the
          // very next model call, including calls inside this execution loop.
          const currentGeneralAgentTools = selectGeneralAgentToolsForTurn({
            request: getRequest(),
            state: { toolResults: [...state.toolResults, ...liveToolResults] },
            tools: buildGeneralAgentTools(getDiscoveredTools(getBoot().state.runId), this.disabledTools),
          });
          // The role prompt is built ONCE per autonomous run (see `run()` ->
          // `systemPromptPrefix`) and reused byte-for-byte on every model call,
          // which is what keeps the provider's prefix cache hitting across
          // compaction and cockpit refresh.
          //
          // The tool inventory is the one thing appended per call, because it
          // is the one thing that legitimately changes mid-run: discovering a
          // tool must remove it from this list on the very next call, or the
          // model keeps being told a tool it now holds a schema for is still
          // locked. Appending is what makes that free — the cached prefix is
          // untouched, and only the tail after it is new bytes.
          const currentSystem = systemPromptPrefix
            + renderAvailableTools(getBoot().state.runId, this.disabledTools);

          // ─── Cockpit insert (once per run) ─────────────────────────
          // The cockpit is the model's anchor for the run's environment,
          // trust posture, trusted project context, and trusted skill
          // names. It is inserted ONCE per run on the first iteration;
          // subsequent iterations do NOT rebuild the cockpit (no mutation
          // refresh, no read-only rebuild). The model receives fresh tool
          // results on each turn and tool discovery still flows via the
          // API `tools` field. Keeping the cockpit stable across turns
          // also keeps its byte representation stable, which lets
          // provider prompt caches reuse the prefix.
        // Pi-parity: the runtime no longer injects a curated cockpit
        // context bundle. The model explores the workspace itself with
        // its own tool calls. We still need to surface the raw user
        // prompt as a user message on the first iteration of every
        // run (including after named-session resume); before, that was
        // On subsequent iterations the prompt is already in liveConversation.
        if (!currentRequestLogged && rawUserPrompt) {
          currentRequestLogged = true;
          liveConversation.push({ role: "user", name: CURRENT_REQUEST_MESSAGE_NAME, content: rawUserPrompt });
          await appendSessionTreeMessage(this.trajectoryLogger, {
            runId: getBoot().state.runId,
            sessionId: getBoot().state.sessionId,
            message: {
              role: "user",
              name: CURRENT_REQUEST_MESSAGE_NAME,
              content: rawUserPrompt,
            },
          });
        }
        const steeringMessages = this.input.turnControl?.drain() ?? [];
        for (const content of steeringMessages) {
          liveConversation.push({ role: "user", content });
          await appendSessionTreeMessage(this.trajectoryLogger, {
            runId: getBoot().state.runId,
            sessionId: getBoot().state.sessionId,
            message: { role: "user", content },
          });
        }

          const turnRequest: GenerateRequest = {
            role: effectiveMainAgentRole,
            source: "main_agent",
            system: currentSystem,
            messages: liveConversation,
            tools: currentGeneralAgentTools,
            ...(selectMainAgentMaxTokensForTurn({ request: getRequest(), state }) !== undefined
              ? { maxTokens: selectMainAgentMaxTokensForTurn({ request: getRequest(), state }) }
              : {}),
            ...(this.input.abortSignal ? { abortSignal: this.input.abortSignal } : {}),
          };
          // The reference loop has no heuristic to break after N empty turns or after a
          // fixed tool-batch count. The only terminal condition is the
          // upstream signal (finishReason === "stop" or "length" or
          // "end_turn", or no tool calls). Everything else stays in the
          // loop. The model owns the stop decision.
          // Conversation shape after every model turn matches the
          // reference loop's order:
          //   [user, ..., assistant.tool_calls, tool, tool, tool, ...]
          //
          // Tools fire in parallel via the island partitioner when
          // possible (reads + non-barrier shell in parallel; disjoint
          // edits/writes in parallel; barrier shell flushes prior).
          // Each tool_call id gets exactly one matching tool_result
          // message — no order reversal and no unmatched-call stalls.
          const turn = await streamMainAgentResponseWithTransportRetry(
            this.input.modelGateway,
            turnRequest,
            this.trajectoryLogger,
            ctxHooks,
            softCap,
            getBoot().state.runId,
            {
              writeHumanOutput: this.input.writeHumanOutput !== false,
              onMessageDelta: async (text) => {
                await emitRuntimeEvent(this.input.eventSink, { type: "assistant.message.delta", text });
                if (this.input.hooks) {
                  await this.input.hooks.emit({
                    name: "AssistantMessageDelta",
                    payload: { text, role: "assistant", done: false },
                    blockable: false,
                  });
                }
              },
              onReasoningDelta: async (text) => {
                await emitRuntimeEvent(this.input.eventSink, { type: "assistant.reasoning.delta", text });
                if (this.input.hooks) {
                  await this.input.hooks.emit({
                    name: "ReasoningDelta",
                    payload: { text, done: false },
                    blockable: false,
                  });
                }
              },
            },
          );
          // ─── Context-engineering: AFTER-MODEL-CALL ───────────────────────
          try {
            await ctxHooks.onAfterModelCall({
              workspaceRoot: this.input.workspaceRoot,
              runId: getBoot().state.runId,
              sessionId: getBoot().state.sessionId,
              traceId: getBoot().state.runId,
              messages: liveConversation,
              modelResponse: (turn as any).raw ?? turn,
              softCap,
              trajectoryLogger: this.trajectoryLogger,
            });
          } catch { /* swallow */ }

          // Stash provider usage for token-native compaction gates.
          try {
            const usage = (turn as any).usage;
            const inputTokens =
              typeof usage?.inputTokens === "number"
                ? usage.inputTokens
                : typeof (turn as any).raw?.usage?.inputTokens === "number"
                  ? (turn as any).raw.usage.inputTokens
                  : undefined;
            if (typeof inputTokens === "number" && inputTokens > 0) {
              runState.lastInputTokens = inputTokens;
            }
          } catch { /* best-effort */ }

          // ─── Thinking wrap ───────────────────────────────────────────────
          // Universal across providers: prefer the dedicated reasoning
          // channel (Anthropic thinking blocks, OpenAI-compatible reasoning
          // deltas). When a model embeds reasoning inside content
          // (<think>…</think> and friends), extract it and strip it from
          // the visible assistant text so reasoning lands in a thinking
          // record (session.jsonl message + conversation.md), never inside
          // the assistant message.
          const channelReasoning = typeof (turn as any).reasoningContent === "string"
            ? ((turn as any).reasoningContent as string).trim()
            : "";
          const rawTurnContent = typeof (turn as any).content === "string" ? ((turn as any).content as string) : "";
          const inlineReasoning = extractThinkingBlocks(rawTurnContent).trim();
          const visibleContent = inlineReasoning ? stripThinkingBlocks(rawTurnContent).trim() : rawTurnContent;
          (turn as { content?: string }).content = visibleContent;
          const turnReasoning = channelReasoning || inlineReasoning;
          /*
           * A transport-fallback turn is the runtime talking, not the model,
           * and its text is a note addressed to the model ("you decide what to
           * do next…"). Streaming that to the transcript put runtime
           * instructions in the conversation as an assistant reply, and then
           * the same paragraph appeared a second time inside the failure alert,
           * because the blocker is built from the same words.
           *
           * The run still needs the note in its own conversation to decide what
           * to do next — that happens in `liveConversation` below. What it does
           * not need is for the note to be presented as the model's answer.
           */
          const isRuntimeSyntheticTurn = Boolean((turn as any)?.raw?.transportFallback);
          if (visibleContent && !isRuntimeSyntheticTurn) {
            await emitRuntimeEvent(this.input.eventSink, {
              type: "assistant.message.completed",
              text: visibleContent,
            });
          }
          if (turnReasoning) {
            await emitRuntimeEvent(this.input.eventSink, {
              type: "assistant.reasoning.completed",
              text: turnReasoning,
            });
          }
          const turnUsage = (turn as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
          if (turnUsage && typeof turnUsage.inputTokens === "number" && typeof turnUsage.outputTokens === "number") {
            await emitRuntimeEvent(this.input.eventSink, {
              type: "token.usage",
              inputTokens: turnUsage.inputTokens,
              outputTokens: turnUsage.outputTokens,
              ...this.contextWindowInfo(),
            });
          }
          if (turnReasoning) {
            await this.trajectoryLogger
              .write({
                event_id: randomUUID(),
                run_id: getBoot().state.runId,
                session_id: getBoot().state.sessionId,
                trace_id: getBoot().state.runId,
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "thinking",
                level: getBoot().state.logLevel,
                content: turnReasoning,
                turn_index: liveModelTurnIndex,
              })
              .catch(() => undefined);
          }
          await this.trajectoryLogger
            .write({
              event_id: randomUUID(),
              run_id: getBoot().state.runId,
              session_id: getBoot().state.sessionId,
              trace_id: getBoot().state.runId,
              timestamp: new Date().toISOString(),
              log_schema_version: 1,
              kind: "assistant_message",
              level: getBoot().state.logLevel,
              content: typeof turn.content === "string" ? turn.content : "",
              turn_index: liveModelTurnIndex,
              tool_names: ((turn.toolCalls ?? []) as ToolCall[]).map((call) => call.name),
              ...(((turn.toolCalls ?? []) as ToolCall[]).length
                ? {
                    tool_calls: ((turn.toolCalls ?? []) as ToolCall[]).map((call) => ({
                      id: call.id,
                      name: call.name,
                      args: (call.args ?? {}) as Record<string, unknown>,
                    })),
                  }
                : {}),
            })
            .catch(() => undefined);
          this.trajectoryLogger.setTurnIndex(liveModelTurnIndex);

          liveModelTurnIndex += 1;

          const tc = (turn.toolCalls ?? []) as ToolCall[];
          if (turn.content) {
            lastAssistantMessage = turn.content;
          }
          // If the provider emitted tool_calls that failed ToolCallSchema after
          // normalize, surface the parse errors so the model can repair instead
          // of silently retrying the same broken call (or claiming it ran).
          const droppedRaw = (turn as any)?.raw?.droppedToolCalls;
          if (
            tc.length === 0 &&
            Array.isArray(droppedRaw) &&
            droppedRaw.length > 0
          ) {
            const detail = droppedRaw
              .map(
                (d: { name?: string; id?: string; error?: string }) =>
                  `- ${d.name ?? "unknown"} (${d.id ?? "?"}): ${d.error ?? "invalid args"}`,
              )
              .join("\n");
            // The rejected calls were stripped from the assistant message above,
            // so from the model's point of view its own transcript shows no tool
            // call at all. Saying "your previous tool_calls" without that context
            // reads as a claim about something it can see it did not do, and the
            // model pushes back instead of repairing. Name the discrepancy.
            const feedback =
              `[runtime notice] You emitted the tool_calls below, but they failed runtime schema validation and were NOT executed. ` +
              `They were also stripped from the assistant message you can see above, so your transcript looks as if you made no call — that is expected, not a fabrication:\n${detail}\n` +
              `Re-emit them with corrected arguments (or a corrected tool name). Do not claim those tools already ran.`;
            liveConversation.push({
              role: "assistant",
              content: turn.content ?? "",
              ...(turnReasoning ? { reasoning: turnReasoning } : {}),
            });
            liveConversation.push({ role: "user", content: feedback });
            await this.trajectoryLogger
              .write({
                event_id: randomUUID(),
                run_id: getBoot().state.runId,
                session_id: getBoot().state.sessionId,
                trace_id: getBoot().state.runId,
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "tool_call_parse_error",
                level: getBoot().state.logLevel,
                dropped: droppedRaw,
              } as any)
              .catch(() => undefined);
            continue;
          }
          if (tc.length === 0) {
            const assistantText = typeof turn.content === "string" ? turn.content.trim() : "";
            if ((turn as any)?.raw?.transportFallback) {
              /*
               * The turn is a stand-in the retry helper synthesises after the
               * provider has refused every attempt, not something the model
               * said. Its `content` is a note addressed to the model — "you
               * decide what to do next" — and it was reaching the screen as
               * the assistant's reply, under an alert that repeated it. The
               * helper now supplies the sentence a person should read instead,
               * and the note stays where it belongs.
               *
               * `lastAssistantMessage` is left alone for the same reason: with
               * no reply from this turn, the transcript must not show the
               * previous turn's text as though it were this one's.
               */
              lastAssistantMessage = "";
              terminalRuntimeBlocker = {
                source: "model",
                code: "main_agent_transport_error",
                message:
                  (turn as any)?.raw?.transportBlockerMessage
                  || "Main-agent provider transport retries were exhausted.",
              };
            }
            if (
              assistantText
              && hasUnexecutedActionPromise(assistantText)
              && prematureStopNudges < PREMATURE_STOP_MAX_NUDGES
              && (!turn.finishReason || turn.finishReason === "stop" || turn.finishReason === "end_turn")
            ) {
              prematureStopNudges += 1;
              liveConversation.push({ role: "assistant", content: turn.content ?? "", ...(turnReasoning ? { reasoning: turnReasoning } : {}) });
              liveConversation.push({
                role: "user",
                content:
                  "Your previous response promised a concrete action but emitted no structured tool_calls, " +
                  "so that action did not occur. Do not narrate a future action. Emit the required tool_call now, " +
                  "or, if every requested artifact and check already exists, return a final evidence summary with " +
                  "no future-action language.",
              });
              await this.trajectoryLogger
                .write({
                  event_id: randomUUID(),
                  run_id: getBoot().state.runId,
                  session_id: getBoot().state.sessionId,
                  trace_id: getBoot().state.runId,
                  timestamp: new Date().toISOString(),
                  log_schema_version: 1,
                  kind: "premature_stop_nudge",
                  level: getBoot().state.logLevel,
                  assistant_excerpt: assistantText.slice(-300),
                  nudge_count: prematureStopNudges,
                  reason: "promised_action_without_tool_call",
                })
                .catch(() => undefined);
              continue;
            }
            // OMP #handleEmptyAssistantStop: empty stop is a harness glitch —
            // retry a few times. Non-empty text-only stop is model-owned.
            if (
              !assistantText &&
              emptyStopRetries < EMPTY_STOP_MAX_RETRIES &&
              (!turn.finishReason ||
                turn.finishReason === "stop" ||
                turn.finishReason === "end_turn" ||
                turn.finishReason === "toolUse")
            ) {
              emptyStopRetries += 1;
              liveConversation.push({
                role: "user",
                content:
                  "Your previous turn returned no tool_calls and an empty assistant_message. " +
                  "Either take the next concrete action with structured tool_calls, or emit a " +
                  "short final summary and stop. Do not return empty again.",
              });
              await this.trajectoryLogger
                .write({
                  event_id: randomUUID(),
                  run_id: getBoot().state.runId,
                  session_id: getBoot().state.sessionId,
                  trace_id: getBoot().state.runId,
                  timestamp: new Date().toISOString(),
                  log_schema_version: 1,
                  kind: "empty_stop_retry",
                  level: getBoot().state.logLevel,
                  attempt: emptyStopRetries,
                  max_attempts: EMPTY_STOP_MAX_RETRIES,
                } as any)
                .catch(() => undefined);
              continue;
            }
            // The ladder above is the only thing between an empty stop and a
            // silent turn. Once it is exhausted the model has returned nothing
            // three times running, and falling through leaves `assistantMessage`
            // empty — which reaches the transcript as a user message with no
            // reply, no error and no spinner, permanently. Record why, so the
            // turn can close as failed with something the user can act on.
            //
            // Not hypothetical: DeepInfra's GLM-5.3-Flash answers identical
            // requests with `finish_reason: "stop"` and no content or
            // tool_calls roughly four times in six, so this path is the
            // expected outcome for a real fraction of turns.
            if (!assistantText && emptyStopRetries >= EMPTY_STOP_MAX_RETRIES) {
              terminalRuntimeBlocker = {
                source: "model",
                code: "empty_model_response",
                message:
                  `The model returned ${EMPTY_STOP_MAX_RETRIES} empty responses in a row — no text and no tool calls — `
                  + "and the run was stopped. This is usually the provider rather than your prompt: send the message "
                  + "again, or switch models.",
              };
            }
            if (turn.content) {
              liveConversation.push({ role: "assistant", content: turn.content, ...(turnReasoning ? { reasoning: turnReasoning } : {}) });
            }
            // Incomplete recovery (OMP): finishReason === "length" means the
            // model hit the output/context ceiling mid-turn. Shrink context
            // once and continue so it can finish; only break if recovery fails.
            if (turn.finishReason === "length" && incompleteRecoveryAttempts < 1) {
              incompleteRecoveryAttempts += 1;
              try {
                const softCapValue = getBoot().state.tokenBudget?.softCap ?? 270_000;
                const recovered = await ctxHooks.onProviderTokenLimitError({
                  messages: liveConversation as unknown[],
                  softCap: softCapValue,
                  runId: getBoot().state.runId,
                });
                if (Array.isArray(recovered?.messages) && recovered.messages.length > 0) {
                  replaceConversationMessages(liveConversation, recovered.messages as any[]);
                  await this.trajectoryLogger.write({
                    event_id: randomUUID(),
                    run_id: getBoot().state.runId,
                    session_id: getBoot().state.sessionId,
                    trace_id: getBoot().state.runId,
                    timestamp: new Date().toISOString(),
                    log_schema_version: 1,
                    kind: "ptl_recovery",
                    level: getBoot().state.logLevel,
                    saved_chars: recovered.savedChars ?? 0,
                    remaining_messages: recovered.messages.length,
                    reason: "incomplete_length",
                  } as any).catch(() => undefined);
                  continue;
                }
              } catch { /* fall through to break */ }
            }
            // The model owns the stop. A turn with no structured tool_calls
            // and non-empty text (or exhausted empty-stop retries) is terminal.
            if (
              !turn.finishReason ||
              turn.finishReason === "stop" ||
              turn.finishReason === "length" ||
              turn.finishReason === "end_turn"
            ) {
              const terminalSteering = this.input.turnControl?.drainOrClose();
              if (terminalSteering && terminalSteering.messages.length > 0) {
                for (const content of terminalSteering.messages) {
                  liveConversation.push({ role: "user", content });
                  await appendSessionTreeMessage(this.trajectoryLogger, {
                    runId: getBoot().state.runId,
                    sessionId: getBoot().state.sessionId,
                    message: { role: "user", content },
                  });
                }
                continue;
              }
              break;
            }
            continue;
          }
          // 1. Push the assistant message FIRST (the reference loop's order).
          liveConversation.push({
            role: "assistant",
            content: turn.content ?? "",
            ...(turnReasoning ? { reasoning: turnReasoning } : {}),
            tool_calls: tc.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: {
                name: c.name,
                arguments: JSON.stringify((c.args ?? {}) as Record<string, unknown>),
              },
            })),
          });
          // 2. Split control-plane calls out of the executable batch (R2).
          // `advance_step` / `update_plan` / `update_todo` never reach the
          // executor: `update_plan`/`update_todo` merge into plan/todo
          // state here, and `advance_step` is recorded as an advancement
          // signal. Each still receives an advisory tool result below so
          // every model-emitted tool_call id gets exactly one matching
          // tool message.
          const liveSplit = splitControlToolCalls(tc);
          const prevPlan = livePlanState;
          const prevTodo = liveTodoState;
          const advisoryUpdate = applyAdvisoryToolCalls(
            { planState: livePlanState, todoState: liveTodoState },
            liveSplit.advisoryToolCalls ?? [],
          );
          await emitPlanTodoDelta(
            this.input.eventSink,
            prevPlan,
            advisoryUpdate.planState,
            prevTodo,
            advisoryUpdate.todoState,
          );
          livePlanState = advisoryUpdate.planState ?? livePlanState;
          liveTodoState = advisoryUpdate.todoState ?? liveTodoState;
          const advisoryResults = advisoryUpdate.toolResults ?? [];
          let advanceResult: ToolResult | undefined;
          if (liveSplit.advancementSignal) {
            liveAdvancementEvidence = [
              ...liveAdvancementEvidence,
              ...(liveSplit.advancementSignal.args.evidence ?? []),
              liveSplit.advancementSignal.args.summary,
            ].filter(Boolean).slice(-20);
            advanceResult = makeAdvisoryToolResult(liveSplit.advancementSignal, {
              advanced: true,
              summary: liveSplit.advancementSignal.args.summary,
            });
            await this.trajectoryLogger
              .write({
                event_id: randomUUID(),
                run_id: getBoot().state.runId,
                session_id: getBoot().state.sessionId,
                trace_id: getBoot().state.runId,
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "plan_step_advance",
                level: getBoot().state.logLevel,
                summary: liveSplit.advancementSignal.args.summary,
                evidence: liveSplit.advancementSignal.args.evidence ?? [],
              } as any)
              .catch(() => undefined);
          }

          // Execute the remaining tools in parallel via the scheduler
          // (island partitioner). The scheduler returns one result per
          // executable call, in original order. If a tool call somehow
          // misses a result, fall through to executing it directly so the
          // model still gets the real tool output rather than a synthetic
          // placeholder.
          const liveExecutor = executor!;
          const liveRecovery = getRecoverySession();
          const scheduled = await executeToolCalls(
            liveSplit.executableToolCalls,
            liveExecutor,
            liveRecovery,
            this.input.abortSignal,
          );
          const currentBatchResults: ToolResult[] = [];
          let executableIndex = 0;
          for (let i = 0; i < tc.length; i += 1) {
            const call = tc[i]!;
            const id = call.id;
            let result: ToolResult | undefined;
            if (liveSplit.advisoryToolCalls?.some((adv) => adv.id === id)) {
              result = advisoryResults.find((adv) => adv.toolCallId === id);
            } else if (liveSplit.advancementSignal?.id === id) {
              result = advanceResult;
            } else {
              result = scheduled.results[executableIndex];
              executableIndex += 1;
            }
            if (!result) {
              // Scheduler invariant: one result per model-emitted call.
              // If broken, don't invent a synthetic prior-failure result
              // — execute the missing call directly so the model
              // receives the real tool output/error.
              try {
                result = await liveExecutor.execute(call);
              } catch (error) {
                result = {
                  name: call.name,
                  toolCallId: id,
                  ok: false as const,
                  output: "",
                  durationMs: 0,
                  error: {
                    code: "executor_threw",
                    message: error instanceof Error ? error.message : String(error),
                  },
                };
              }
              if (!result.toolCallId) result = { ...result, toolCallId: id };
            }
            liveToolResults.push(result);
            currentBatchResults.push(result);
            liveEvents.push(makeEvent(getRequest(), "tool_call_completed", { result }));

            // ─── Context-engineering: AFTER-TOOL-RESULT ─────────────────
            // Run the wiring hook for normalized envelope / spillover on
            // each tool result. The hook may replace `result.output`
            // with a head+tail preview and write bash_head_tail trajectory
            // events when truncation was observed.
            try {
              const outputObj = (result as any).output;
              // ForegroundShellResult uses `logPath` (not
              // `persisted_output_path`). BashOutput uses the latter.
              // Try both — different layers expose different shapes.
              const persistedPath = outputObj?.persisted_output_path ?? outputObj?.logPath;
              let persistedSize = outputObj?.persisted_output_size;
              // If persisted_output_size is not on the result object, stat
              // the persisted_output_path file (the bash executor writes
              // the full output to disk when persist threshold is crossed).
              if (typeof persistedSize !== "number" && persistedPath) {
                try {
                  const fsModule = await import("node:fs");
                  if (fsModule.existsSync(persistedPath)) {
                    const stat = fsModule.statSync(persistedPath);
                    persistedSize = stat.size;
                  }
                } catch { /* best-effort */ }
              }
              const outputString = typeof outputObj === "string"
                ? outputObj
                : JSON.stringify(outputObj ?? "");
              const afterTr = await ctxHooks.onAfterToolResult({
                workspaceRoot: this.input.workspaceRoot,
                runId: getBoot().state.runId,
                sessionId: getBoot().state.sessionId,
                traceId: getBoot().state.runId,
                toolCallId: id,
                toolName: call.name,
                output: outputString,
                trajectoryLogger: this.trajectoryLogger,
                persistedOutputSize: typeof persistedSize === "number" ? persistedSize : undefined,
                // The complete-output pointer the tool result carries, so the
                // transcript row can name the file the model was told about.
                fullOutputPath:
                  typeof outputObj?.full_output_path === "string"
                    ? outputObj.full_output_path
                    : typeof outputObj?.fullOutputPath === "string"
                      ? outputObj.fullOutputPath
                      : undefined,
              } as any);
              if ((afterTr as any)?.output && (afterTr as any).output !== result.output) {
                (result as any).output = (afterTr as any).output;
              }
            } catch { /* swallow */ }

            const rawToolContent = result.ok
              ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? ""))
              : (result.error?.message
                  ? `Error: ${result.error.message}${result.error.code ? ` (code=${result.error.code})` : ""}`
                  : "Error: tool returned a non-ok result");
            const toolContentTrust = classifyReadFileTrust(result, this.input.workspaceRoot);
            const toolContent = markTrust(rawToolContent, toolContentTrust, result.name);
            liveConversation.push({
              role: "tool",
              tool_call_id: id,
              is_error: !result.ok,
              content: toolContent,
              timestamp: Date.now(),
            } as any);
          }
          // Same repair path as the all-calls-dropped branch above, for the
          // turn that mixed valid and malformed calls. Without this the model
          // sees its good calls execute and never learns the other one was
          // discarded, so it proceeds as if that work happened.
          if (Array.isArray(droppedRaw) && droppedRaw.length > 0) {
            const detail = droppedRaw
              .map(
                (d: { name?: string; id?: string; error?: string }) =>
                  `- ${d.name ?? "unknown"} (${d.id ?? "?"}): ${d.error ?? "invalid args"}`,
              )
              .join("\n");
            liveConversation.push({
              role: "user",
              content:
                `[runtime notice] Alongside the tool calls that ran, you emitted the calls below. They failed runtime schema validation, were NOT executed, and were stripped from the assistant message above:\n${detail}\n` +
                `Re-emit them with corrected arguments. Do not assume those tools already ran.`,
            });
            await this.trajectoryLogger
              .write({
                event_id: randomUUID(),
                run_id: getBoot().state.runId,
                session_id: getBoot().state.sessionId,
                trace_id: getBoot().state.runId,
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "tool_call_parse_error",
                level: getBoot().state.logLevel,
                dropped: droppedRaw,
              } as any)
              .catch(() => undefined);
          }
          if (scheduled.aborted) {
            // R4: surface the abort instead of swallowing it. Mark the run
            // aborted, reap background processes immediately (they would
            // otherwise leak), and emit a cancellation event so callers
            // don't classify this natural stop as "completed".
            liveAborted = true;
            try {
              await liveExecutor.cleanupBackgroundProcesses("run_aborted");
            } catch { /* best-effort */ }
            liveEvents.push(makeEvent(getRequest(), "error", {
              code: "run_aborted",
              reason: String(this.input.abortSignal?.reason ?? "aborted"),
            }));
            await this.trajectoryLogger
              .write({
                event_id: randomUUID(),
                run_id: getBoot().state.runId,
                session_id: getBoot().state.sessionId,
                trace_id: getBoot().state.runId,
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "run_aborted",
                level: getBoot().state.logLevel,
                reason: String(this.input.abortSignal?.reason ?? "aborted"),
              } as any)
              .catch(() => undefined);
            break;
          }
          // Mid-run maintain (OMP maintainContextMidRun): cheap supersede
          // prune after each tool batch so read-heavy loops shed stale
          // results before the next model call. Full shake/summary still
          // run exclusively via ctxHooks.onBeforeModelCall (single path).
          try {
            const { pruneSupersededToolResults } = await import("../context/supersede-prune.js");
            const mid = pruneSupersededToolResults(liveConversation as any[], { warmPrefixCount: 1 });
            if (mid.performed) {
            }
          } catch { /* best-effort */ }
          continue;
        }

        // R3/R4: the loop exited either by model self-stop, abort, or the
        // iteration cap. Surface the abort/cap as an error event and a
        // runtime blocker so the run is not misclassified as a natural
        // completed stop.
        const loopCapped = !liveAborted && liveIteration >= liveIterationLimit;
        if (loopCapped) {
          liveEvents.push(makeEvent(getRequest(), "error", {
            code: "iteration_limit",
            iterations: liveIteration,
            limit: liveIterationLimit,
          }));
        }
        const loopStoppedByExternal = liveAborted || loopCapped;
        const surfacedBlockers =
          loopStoppedByExternal
            ? [
                ...state.runtimeBlockers,
                ...(terminalRuntimeBlocker ? [terminalRuntimeBlocker] : []),
                {
                  source: "runtime" as const,
                  code: liveAborted ? "run_aborted" : "iteration_limit",
                  message: liveAborted
                    ? "The run was aborted."
                    : `The run reached the iteration cap of ${liveIterationLimit} model turns and was stopped.`,
                },
              ]
            : terminalRuntimeBlocker
              ? [...state.runtimeBlockers, terminalRuntimeBlocker]
              : state.runtimeBlockers;

        // We have already executed everything; the engine's downstream
        // nodes should not re-execute. Pass empty plannedToolCalls.
        return {
          plannedToolCalls: [],
          assistantMessage: lastAssistantMessage,
          events: [...state.events, ...liveEvents],
          feedback: state.feedback,
          runtimeBlockers: surfacedBlockers,
          toolResults: [...(state.toolResults ?? []), ...liveToolResults],
          ...(livePlanState !== state.planState ? { planState: livePlanState } : {}),
          ...(liveTodoState !== state.todoState ? { todoState: liveTodoState } : {}),
          ...(loopStoppedByExternal ? { aborted: liveAborted, loopCapped } : {}),
          iteration: state.iteration + liveIteration,
        } satisfies Partial<GraphState>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.trajectoryLogger.write({
          event_id: randomUUID(),
          run_id: getBoot().state.runId,
          session_id: getBoot().state.sessionId,
          trace_id: getBoot().state.runId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: "assistant_message",
          level: getBoot().state.logLevel,
          content: `[main_agent_error] ${message}`,
        });
        /*
         * A model call that threw is a failed run, and for a long time this
         * catch said otherwise.
         *
         * It wrote the error text into `assistantMessage` as though the model
         * had said it, returned no blocker, and let the graph route
         * main_agent → summarize → metrics. Nothing was ever emitted as an
         * assistant message, so the transcript stayed empty; `task_completed`
         * fired anyway, because nothing had failed as far as that check could
         * see; and the turn closed as `completed` carrying the error text as
         * its reply. The user's screen showed their own message and then
         * nothing, permanently — no reply, no error, no spinner.
         *
         * The comment that used to sit here claimed the error would be
         * "surfaced to the model" and "picked up on the next pass". There is no
         * next pass: `plannedToolCalls: []` routes straight to summarize. The
         * error was surfaced to nobody.
         *
         * The trajectory line above is a debug trail, not a reply, so it is
         * still not what belongs in `assistantMessage`. Raise the blocker and
         * leave the message empty; the failure reaches the user through the
         * turn's own status, which `Transcript.tsx` already renders as the
         * reason it is.
         *
         * This catch holds every model-call failure the transport classifier
         * did not claim, so the text has to describe the failure without
         * assuming which kind it was.
         */
        terminalRuntimeBlocker = {
          source: "model",
          code: "model_call_failed",
          message:
            `The model call failed and the run was stopped: ${message}\n`
            + "Send the message again, or switch models in the composer.",
        };
        return {
          plannedToolCalls: [],
          assistantMessage: "",
          feedback: [...state.feedback, message],
          runtimeBlockers: [...state.runtimeBlockers, terminalRuntimeBlocker],
          iteration: state.iteration + 1,
        } satisfies Partial<GraphState>;
      }
    };

    const validateToolCallsNode = async (state: GraphState) => {
      let toolCalls = state.plannedToolCalls ?? [];
      // Terminal assistant text with no tool calls is the model-owned stop.
      // Route it directly to the final summary without a completion gate.
      const validation = validateToolCallBatch(toolCalls, {
        agentRole: "main",
        assistantMessage: state.assistantMessage,
        validateSchema: (call) => {
          const spec = toolRegistry[call.name as keyof typeof toolRegistry];
          if (!spec) return { ok: true };
          const parsed = spec.argsSchema.safeParse(call.args ?? call.arguments ?? {});
          return parsed.success ? { ok: true } : { ok: false, details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
        },
      });
      if (!validation.ok) {
        const blockers = validation.blockers.map((blocker) => runtimeBlockerFromToolValidation(blocker));
        const attempts = state.completionGateAttempts + 1;
        return {
          split: { executableToolCalls: [] },
          plannedToolCalls: [],
          runtimeBlockers: [...state.runtimeBlockers, ...blockers],
          feedback: [...state.feedback, ...blockers.map((blocker) => blocker.message)],
          completionGateAttempts: attempts,
          completionGateExhausted: false,
        } satisfies Partial<GraphState>;
      }


      const split = splitControlToolCalls(toolCalls);
      const advisoryUpdate = applyAdvisoryToolCalls(state, split.advisoryToolCalls ?? []);
      await emitPlanTodoDelta(
        this.input.eventSink,
        state.planState,
        advisoryUpdate.planState,
        state.todoState,
        advisoryUpdate.todoState,
      );
      const categorized = split.executableToolCalls.map((call) => ({ id: call.id, name: call.name, kind: classifyToolCall(call) }));
      return {
        split,
        ...advisoryUpdate,
        ...(advisoryUpdate.toolResults?.length
          ? { toolResults: [...state.toolResults, ...advisoryUpdate.toolResults] }
          : {}),
        runtimeBlockers: [],
        events: [...state.events, makeEvent(getRequest(), "assistant_delta", { event: "tool_calls_categorized", categorized })],
      } satisfies Partial<GraphState>;
    };

    const compactionNode = async (state: GraphState) => {
      if (state.mode === "needs_model") return {};
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: "Content Prep",
        to_step: "Compaction",
      });
      const compacted = await prepareRuntimeContent({
        workspaceRoot: this.input.workspaceRoot,
        ...(this.input.userHome ? { userHome: this.input.userHome } : {}),
        prompt: state.prompt,
        maxContextTokens: Math.max(2000, Math.floor(getBoot().state.tokenBudget.softCap * 0.1)),
        compactToolResults: true,
        prunerConfig: this.config.pruner,
        toolResults: state.toolResults,
        backgroundProcesses: getExecutor().getBackgroundProcesses(),
        ...(this.input.middlewares ? { middlewares: this.input.middlewares as any } : {}),
      });
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: "Compaction",
        to_step: "Stream Assistant",
      });
      return {
        contentPrep: compacted,
        contentFingerprint: compacted.preparedContext.fingerprint,
      };
    };

    const noModelNode = async (state: GraphState) => {
      const activeRequest = getRequest();
      const message = "Autonomous Reaper requires a live LLM provider. Provide modelGateway or explicit tool_calls.";
      const events = [
        makeEvent(activeRequest, "error", { message }),
        makeEvent(activeRequest, "assistant_message", { content: message }),
      ];
      return { ...state, events, assistantMessage: message, done: true };
    };


    const categorizeToolsNode = async (state: GraphState) => {
      const activeRequest = getRequest();
      const toolCalls =
        state.mode === "autonomous"
          ? state.plannedToolCalls ?? []
          : (Array.isArray(activeRequest.payload.tool_calls) ? activeRequest.payload.tool_calls : [])
              .map((call) => ToolCallSchema.parse(normalizeToolCall(call)));
      const split = splitControlToolCalls(toolCalls);
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: "Stream Assistant",
        to_step: "Tool Categorization",
      });
      const categorized = split.executableToolCalls.map((call) => ({ id: call.id, name: call.name, kind: classifyToolCall(call) }));
      const advisoryUpdate = applyAdvisoryToolCalls(state, split.advisoryToolCalls ?? []);
      await emitPlanTodoDelta(
        this.input.eventSink,
        state.planState,
        advisoryUpdate.planState,
        state.todoState,
        advisoryUpdate.todoState,
      );
      return {
        split,
        ...advisoryUpdate,
        ...(advisoryUpdate.toolResults?.length
          ? { toolResults: [...state.toolResults, ...advisoryUpdate.toolResults] }
          : {}),
        events: [...state.events, makeEvent(activeRequest, "assistant_delta", { event: "tool_calls_categorized", categorized })],
      };
    };

    const permissionCheckNode = async (state: GraphState) => {
      const approvedEvent = makeEvent(getRequest(), "assistant_delta", {
        event: "tool_calls_approved",
        count: state.split?.executableToolCalls.length ?? 0,
      });
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: "Tool Categorization",
        to_step: "Permission Check",
      });
      return { events: [...state.events, approvedEvent] };
    };

    const executeToolsNode = async (state: GraphState) => {
      const activeRequest = getRequest();
      const toolCalls =
        state.mode === "autonomous"
          ? state.plannedToolCalls ?? []
          : (Array.isArray(activeRequest.payload.tool_calls) ? activeRequest.payload.tool_calls : [])
              .map((call) => ToolCallSchema.parse(normalizeToolCall(call)));
      const split = splitControlToolCalls(toolCalls);
      const requestMetadata = activeRequest.metadata && typeof activeRequest.metadata === "object" ? (activeRequest.metadata as Record<string, unknown>) : {};
      const execMode = requestMetadata.transport === "http_json" && requestMetadata.yolo === true;
      const executableToolCalls = normalizeExecutableToolCalls(split.executableToolCalls);
      /*
       * Second half of the thread's tool policy. The tool list already omitted
       * these names, so a well-behaved model never asks — but a thread that
       * disables a tool mid-conversation keeps the earlier turns in its
       * transcript, and the model reads those as evidence the tool exists.
       * Refusing here means the disabled state holds even then, and the model
       * gets a reason instead of silence.
       *
       * Sibling calls in the same batch still run: a policy refusal is one
       * tool's outcome, not a batch abort, and dropping the others would let a
       * single stale call cost the model the work it legitimately asked for.
       */
      const [policyBlocked, allowedToolCalls] = partitionByToolPolicy(executableToolCalls, this.disabledTools);
      const blockedBeforeScheduling: ToolResult[] = policyBlocked;
      const currentStep = state.executionPlan?.[state.currentStepIndex];
      const startedEvents = split.executableToolCalls.map((toolCall) => makeEvent(activeRequest, "tool_call_started", { toolCall }));
      printToolCalls(
        startedEvents
          .filter((ev) => ev && typeof ev === "object" && "payload" in ev)
          .map((ev) => {
            const payload = (ev as { payload?: { toolCall?: { name: string; args?: Record<string, unknown> } } }).payload;
            return payload?.toolCall ?? { name: String((ev as { name?: unknown }).name ?? "tool") };
          }),
      );
      const mutationCheckpointResult = !execMode && batchNeedsMutationCheckpoint(allowedToolCalls)
        ? await createMutationCheckpointResult({
            workspaceRoot: this.input.workspaceRoot,
            runId: getBoot().state.runId,
            toolCalls: allowedToolCalls,
          })
        : undefined;
      const scheduled = mutationCheckpointResult?.ok === false
        ? { results: [], aborted: false }
        : await executeToolCalls(
            allowedToolCalls,
            getExecutor(),
            getRecoverySession(),
            this.input.abortSignal,
          );
      const postMutationResults =
        mutationCheckpointResult?.ok === true
          ? await createPostMutationGitResults(this.input.workspaceRoot, getBoot().state.runId)
          : [];
      const batchResults = [
        ...blockedBeforeScheduling,
        ...scheduled.results,
        ...(mutationCheckpointResult ? [mutationCheckpointResult] : []),
        ...postMutationResults,
      ];
      const toolResults = [...state.toolResults, ...batchResults];
      /*
       * The completion half of the terminal's tool narration. Calls are printed
       * as they are issued; results only for Code Mode, where the script's
       * output is the substance of the call and half a report is not worth
       * printing at all.
       */
      for (const result of batchResults) {
        printToolResult({
          name: result.name,
          ok: result.ok,
          output: result.output,
          ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
        });
      }
      const completedEvents = batchResults.map((result) => makeEvent(activeRequest, "tool_call_completed", { result }));
      const encodingFeedback = buildDerivedSecretEncodingFeedback(toolResults);
      const runtimeGuardFeedback = [
        ...encodingFeedback,
      ];
      return {
        split,
        toolResults,
        feedback: runtimeGuardFeedback.length > 0 ? [...state.feedback, ...runtimeGuardFeedback] : state.feedback,
        events: [...state.events, ...startedEvents, ...completedEvents],
      };
    };

    const queueResultsNode = async (state: GraphState) => {
      let split = state.split;
      const step = state.executionPlan?.[state.currentStepIndex];
      const rawLastBatchFailed = split ? hasFailedCurrentBatch(split.executableToolCalls, state.toolResults) : false;
      const shouldSkipOptionalExploratoryStep =
        state.mode === "autonomous" &&
        Boolean(step) &&
        Boolean(split) &&
        rawLastBatchFailed &&
        isOptionalExploratoryPlanStep(step) &&
        hasLaterPlanStep(state.executionPlan, state.currentStepIndex);
      let lastBatchFailed =
        rawLastBatchFailed &&
        !shouldSkipOptionalExploratoryStep &&
        !(step && split && isTolerableInspectionBatchFailure(step, split.executableToolCalls, state.toolResults));
      const shouldAdvanceBuildConfigStep =
        state.mode === "autonomous" &&
        Boolean(step) &&
        Boolean(split) &&
        lastBatchFailed &&
        shouldAdvanceBuildConfigStepToLaterImplementation({
          step: step!,
          plan: state.executionPlan,
          currentStepIndex: state.currentStepIndex,
          toolCalls: split!.executableToolCalls,
          results: state.toolResults,
        });
      if (shouldAdvanceBuildConfigStep) {
        lastBatchFailed = false;
      }
      const noActionBatch =
        state.mode === "autonomous" &&
        Boolean(split) &&
        split!.executableToolCalls.length === 0 &&
        !split!.advancementSignal;
      if (split && shouldCleanupBackgroundAfterBatch(split.executableToolCalls, state.toolResults, getExecutor().getBackgroundProcesses())) {
        await getExecutor().cleanupBackgroundProcesses("post_foreground_check");
      }
      // The reference loop has no iteration budget, no stuck-detection heuristic, no
      // step-budget feedback. Reaper's natural-stop path is model-driven;
      // we keep state shape compatible but skip the legacy heuristics.
      const stepBudgetDecision = { tripped: false, feedback: [], negativeConstraints: [] };
      // Failed steps remain on the main model path.
      const readOnlyBatchFeedback =
        state.mode === "autonomous" &&
        Boolean(step) &&
        split &&
        split.executableToolCalls.length > 0 &&
        !split.advancementSignal &&
        !lastBatchFailed
          ? [
              ...state.feedback,
              `Step '${step!.id}' did not advance because the model did not emit advance_step. If the whole task is complete, stop with a concise final assistant_message and no tool_calls.`,
              state.readOnlyBatchSignatures.length >= 2
                ? `Step '${step!.id}' has repeated inspection-only batches without progress. Stop reading the same context. Run the step's concrete command/check, make the required edit, request a patch for a real failure, or advance with evidence.`
                : "",
            ]
              .filter(Boolean)
          : state.feedback;
      const deadlinePressure = getRuntimeDeadlinePressure(startedAt);
      const feedback =
        deadlinePressure.feedback && !readOnlyBatchFeedback.includes(deadlinePressure.feedback)
          ? [...readOnlyBatchFeedback, deadlinePressure.feedback]
          : readOnlyBatchFeedback;
      const autoAdvanceReadOnlyInspection =
        state.mode === "autonomous" &&
        Boolean(step) &&
        !split?.advancementSignal &&
        !lastBatchFailed &&
        isReadOnlyInspectionStepDone(step, split);
	      const autoAdvanceVerifiedCommandStep =
	        state.mode === "autonomous" &&
	        Boolean(step) &&
        !split?.advancementSignal &&
        !lastBatchFailed &&
	        isVerificationDrivenPlanStep(step) &&
	        Boolean(split) &&
	        hasSuccessfulCurrentBatchVerification(split!.executableToolCalls, state.toolResults);
	      const autoAdvanceStaticPlannedStep =
	        state.mode === "autonomous" &&
	        Boolean(step) &&
	        step!.tool_calls.length > 0 &&
		        !split?.advancementSignal &&
	        !lastBatchFailed &&
	        state.currentStepIndex + 1 < (state.executionPlan?.length ?? 0);
	      const shouldAdvancePlanStep =
	        state.mode === "autonomous" &&
	        Boolean(step) &&
        !lastBatchFailed &&
        (Boolean(split?.advancementSignal) ||
	          autoAdvanceReadOnlyInspection ||
	          autoAdvanceVerifiedCommandStep ||
	          autoAdvanceStaticPlannedStep ||
	          shouldSkipOptionalExploratoryStep ||
	          shouldAdvanceBuildConfigStep);
      const explicitReadOnlyStepAdvance =
        state.mode === "autonomous" &&
        Boolean(step) &&
        Boolean(split?.advancementSignal) &&
        !lastBatchFailed &&
        isReadOnlyPlanStep(step);
      const shouldAdvanceCurrentStep = shouldAdvancePlanStep || explicitReadOnlyStepAdvance;
      const finalStepAdvancedWithoutCompletion =
        shouldAdvanceCurrentStep && state.currentStepIndex + 1 >= (state.executionPlan?.length ?? 0);
      const canAdvancePlanStep = shouldAdvanceCurrentStep;
      const boundaryPivot = getBoundaryPivotInstruction(state.toolResults);
      const readOnlyBatchSignatures = updateReadOnlyBatchSignatures({
        previous: state.readOnlyBatchSignatures,
        split,
        lastBatchFailed,
      });
      const queuedNegativeConstraints = [...state.negativeConstraints];
      const addQueuedNegativeConstraint = (constraint?: string) => {
        if (constraint && !queuedNegativeConstraints.includes(constraint)) {
          queuedNegativeConstraints.push(constraint);
        }
      };
      if (boundaryPivot) {
        addQueuedNegativeConstraint(boundaryPivot.negativeConstraint);
      }
      addQueuedNegativeConstraint(deadlinePressure.negativeConstraint);
      if (stepBudgetDecision.tripped && !canAdvancePlanStep) {
        for (const constraint of stepBudgetDecision.negativeConstraints) addQueuedNegativeConstraint(constraint);
      }
      const queuedRuntimeBlockers: RuntimeBlocker[] = [];
      if (noActionBatch) {
        queuedRuntimeBlockers.push({
          source: "runtime",
          code: "empty_main_agent_batch",
          message: "The main_agent response produced no executable tool calls.",
        });
      }
      const nextCompletionGateAttempts = queuedRuntimeBlockers.length > 0
        ? state.completionGateAttempts + 1
        : canAdvancePlanStep
          ? 0
          : Number.isFinite(state.completionGateAttempts)
            ? state.completionGateAttempts
            : 0;
      const forcedAdvanceForBudget =
        stepBudgetDecision.tripped &&
        state.mode === "autonomous" &&
        Boolean(step) &&
        Boolean(split) &&
        !split?.advancementSignal;
      if (forcedAdvanceForBudget && split && step) {
        split = {
          ...split,
          advancementSignal: {
            id: `budget-advance-${randomUUID()}`,
            name: "advance_step",
            args: {
              summary: `Step '${step.id}' reached the per-step tool budget without a passing verification signal. Runtime is auto-advancing to the next plan step to avoid an unbounded loop.`,
              evidence: [
                `Step '${step.id}' reached the per-step tool budget without a passing verification signal. The main model remains responsible for any unfinished work.`,
              ],
            },
          },
        };
        addQueuedNegativeConstraint(
          `Step '${step.id}' was auto-advanced because it reached the per-step tool budget. The next step's executor should address any remaining work for this step before moving on.`,
        );
      }
      await this.trajectoryLogger.write({
        event_id: randomUUID(),
        run_id: getBoot().state.runId,
        session_id: getBoot().state.sessionId,
        trace_id: getBoot().state.runId,
        timestamp: new Date().toISOString(),
        log_schema_version: 1,
        kind: "state_transition",
        level: getBoot().state.logLevel,
        from_step: "Execute Tools",
        to_step: "Queue Results",
      });
      return {
        ...(split ? { split } : {}),
        plannedToolCalls: [],
        lastBatchFailed,
        runtimeBlockers: queuedRuntimeBlockers.length > 0 ? [...state.runtimeBlockers, ...queuedRuntimeBlockers] : state.runtimeBlockers,
        readOnlyBatchSignatures,
        ...(boundaryPivot || (stepBudgetDecision.tripped && !canAdvancePlanStep) ? { needsReplan: true } : {}),
        completionGateAttempts: nextCompletionGateAttempts,
        ...{},
        ...(queuedNegativeConstraints.length !== state.negativeConstraints.length
          ? { negativeConstraints: queuedNegativeConstraints }
          : {}),
        feedback: shouldAdvancePlanStep
          ? finalStepAdvancedWithoutCompletion
            ? [
                `Final planned step '${step!.id}' advanced. If the whole requested task is complete, finish with a concise final assistant_message and no tool_calls. Only call concrete repair/check tools if specific work remains.`,
              ]
            : shouldSkipOptionalExploratoryStep
              ? [
                  `Skipped optional exploratory step '${step!.id}' after its diagnostic/check failed. Continue with the next primary deliverable step instead of repairing non-required exploratory harnesses or legacy/demo failures.`,
                ]
              : autoAdvanceVerifiedCommandStep
                ? [`Auto-advanced ${step!.type ?? "command"} step '${step!.id}' because its current batch included a successful real build/test/verification command with no failures.`]
              : shouldAdvanceBuildConfigStep
                ? [
                    `Auto-advanced build-configuration step '${step!.id}' because the build configuration was written and the only remaining failure points at implementation source that is owned by later planned implementation/build steps.`,
                  ]
              : autoAdvanceReadOnlyInspection
                ? [`Auto-advanced read-only ${step!.type ?? "inspect"} step '${step!.id}' because its inspection tools succeeded without failures. Continue with the next concrete implementation/check step.`]
                : []
          : noActionBatch
            ? [
                "The last model response produced no executable tool calls and no completion/advance signal. This is not progress; inspect the needed files or make the smallest concrete repair before continuing.",
              ]
            : [],
        ...(boundaryPivot
          ? {
              feedback: [
                boundaryPivot.feedback,
              ],
            }
          : {}),
        ...(canAdvancePlanStep
          ? {
          currentStepIndex: state.currentStepIndex + 1,
          currentStepToolStartIndex: state.toolResults.length,
          completedStepIds: [...state.completedStepIds, step!.id],
        }
          : {}),
      };
      // Best-effort: keep .reaper/PLAN.md in sync with step completion
      // Fire-and-forget so a slow write does not
      // block the graph node. Errors are logged but not fatal.
      if (canAdvancePlanStep) {
      }
    };


    const summarizeNode = async (state: GraphState) => {
      const activeRequest = getRequest();
      const finalVerification = state.explicitVerification;
      const contentPrep = await prepareRuntimeContent({
        workspaceRoot: this.input.workspaceRoot,
        ...(this.input.userHome ? { userHome: this.input.userHome } : {}),
        prompt: state.prompt,
        maxContextTokens: Math.max(2000, Math.floor(getBoot().state.tokenBudget.softCap * 0.1)),
        prunerConfig: this.config.pruner,
        toolResults: state.toolResults,
        backgroundProcesses: getExecutor().getBackgroundProcesses(),
        ...(this.input.middlewares ? { middlewares: this.input.middlewares as any } : {}),
      });
      // The model owns the stop. We never synthesize a fresh LLM
      // summary here. If the model's assistant message is empty, the
      // summary is empty. If non-empty, that IS the summary — the
      // model's own words, written by the model itself.
      const modelSummary =
        state.assistantMessage?.trim() ||
        (state.mode === "explicit_tools" ? summarizeExplicitToolRun(state.toolResults) : "");
      const nextEvents = [
        ...state.events,
        makeEvent(activeRequest, "assistant_message", { content: modelSummary }),
      ];
      // `task_completed` is the event the metrics node reads to score the run as
      // verified, so a run that stopped short must not carry it — otherwise the
      // failure is recorded as a success in the same breath as being reported.
      const stoppedShort = state.runtimeBlockers.some(isStoppedShortBlocker);
      if (!stoppedShort) {
        nextEvents.push(makeEvent(activeRequest, "task_completed", { verification: finalVerification }));
      }
      return {
        contentPrep,
        contentFingerprint: contentPrep.preparedContext.fingerprint,
        assistantMessage: modelSummary,
        events: nextEvents,
        explicitVerification: finalVerification,
        done: true,
      };
    };

	    const metricsNode = async (state: GraphState) => {
	      const activeBoot = getBoot();
	      const taskCompleted = state.events.some((event) => event.message_type === "task_completed");
	      const transportRetryExhausted = countConsecutiveModelTransportBlockers(state.runtimeBlockers) >= mainAgentTransportRetryLimit();
	      const lowConfidenceCompletionBlocked = state.runtimeBlockers.at(-1)?.code === "low_confidence_completion_blocked";
	      const sessionMetrics = buildSessionMetricsSummary({
	        toolResults: state.toolResults,
	        completionGateAttempts: state.completionGateAttempts,
	        taskCompleted,
        // A successful executor-backed command of the requested verification
        // kind is grounded evidence even when the model ran it directly.
        // For natural stops with no declared verification, the model's own
        // most recent test/build/typecheck run is the observed evidence.
        verifiedCompletion: Boolean(
          taskCompleted
          && (
            state.explicitVerification?.ok === true
            || (hasPassingVerifyAfterLastEdit(state.toolResults)
              && hasPassingGroundedVerification(state.toolResults, getRequest()))
          )
        ),
	        stuckTripped: false,
	        gateExhausted: state.completionGateExhausted,
	        ...(transportRetryExhausted ? { stopReasonOverride: "infra_failed" as const } : {}),
	        ...(lowConfidenceCompletionBlocked ? { stopReasonOverride: "error" as const } : {}),
	      });
	      const metrics = buildTrajectoryEfficiencyMetrics({
	        startedAt,
	        prompt: state.prompt,
	        toolResults: state.toolResults,
	        feedback: state.feedback,
	        negativeConstraints: state.negativeConstraints,
	        completedStepIds: state.completedStepIds,
	        currentStepIndex: state.currentStepIndex,
	        ...(state.executionPlan ? { executionPlan: state.executionPlan } : {}),
	        ...(state.explicitVerification ? { explicitVerification: state.explicitVerification } : {}),
	      });
	      const verificationAttempts = Math.max(
	        countVerificationAttempts(state.toolResults),
	        metrics.verification_attempts,
	      );
	      const mergedMetrics = { ...metrics, ...sessionMetrics, verification_attempts: verificationAttempts };
	      if (this.config.logging.sessionMetrics) {
	        await this.trajectoryLogger.write({
	          event_id: randomUUID(),
	          run_id: activeBoot.state.runId,
	          session_id: activeBoot.state.sessionId,
	          trace_id: activeBoot.state.runId,
	          timestamp: new Date().toISOString(),
	          log_schema_version: 1,
	          kind: "session_metrics",
	          level: activeBoot.state.logLevel,
	          tool_count: metrics.tool_count,
	          failure_count: metrics.failure_count,
	          verification_attempts: verificationAttempts,
	          total_runtime_ms: metrics.total_runtime_ms,
	          ...sessionMetrics,
	          engine_stop_reason: sessionMetrics.stop_reason,
	        });
        if (isReaperDevMode()) await writeTrajectoryMetricsFile(this.input.workspaceRoot, activeBoot.state.runId, mergedMetrics);
	      }
	      return {};
	    };

    const routeAfterBootstrap = (state: GraphState) => {
      if (state.mode === "needs_model") return "no_model";
      if (state.mode === "explicit_tools") return "categorize_tools";
      return "extract_task_contract";
    };
    const routeAfterExtractTaskContract = () => "content_prep";
    const routeAfterContentPrep = (state: GraphState) => {
      if (state.mode !== "autonomous") return "categorize_tools";
      return "main_agent";
    };
    const routeAfterMainAgent = (state: GraphState) =>
      state.plannedToolCalls && state.plannedToolCalls.length > 0
        ? "validate_tool_calls"
        : "summarize";
    const routeAfterToolValidation = (state: GraphState) => {
      if (state.plannedToolCalls?.length === 0) return "main_agent";
      if ((state.split?.executableToolCalls.length ?? 0) > 0) return "permission_check";
      return "main_agent";
    };
    const routeAfterQueue = (state: GraphState) =>
      state.mode === "autonomous" ? "main_agent" : "summarize";

    type RuntimeNodeName =
      | "bootstrap"
      | "extract_task_contract"
      | "content_prep"
      | "main_agent"
      | "validate_tool_calls"
      | "categorize_tools"
      | "permission_check"
      | "execute_tools"
      | "queue_results"
      | "summarize"
      | "no_model"
      | "metrics";

    const nodes: Record<RuntimeNodeName, (state: GraphState) => Promise<Partial<GraphState>> | Partial<GraphState>> = {
      bootstrap: bootstrapNode,
      extract_task_contract: extractTaskContractNode,
      content_prep: contentPrepNode,
      main_agent: mainAgentNode,
      validate_tool_calls: validateToolCallsNode,
      categorize_tools: categorizeToolsNode,
      permission_check: permissionCheckNode,
      execute_tools: executeToolsNode,
      queue_results: queueResultsNode,
      summarize: summarizeNode,
      no_model: noModelNode,
      metrics: metricsNode,
    };

    const nextNode = (node: RuntimeNodeName, state: GraphState): RuntimeNodeName | undefined => {
      switch (node) {
        case "bootstrap": return routeAfterBootstrap(state) as RuntimeNodeName;
        case "extract_task_contract": return routeAfterExtractTaskContract() as RuntimeNodeName;
        case "content_prep": return routeAfterContentPrep(state) as RuntimeNodeName;
        case "main_agent": return routeAfterMainAgent(state) as RuntimeNodeName;
        case "validate_tool_calls": return routeAfterToolValidation(state) as RuntimeNodeName;
        case "categorize_tools": return "permission_check";
        case "permission_check": return "execute_tools";
        case "execute_tools": return "queue_results";
        case "queue_results": return routeAfterQueue(state) as RuntimeNodeName;
        case "summarize": return "metrics";
        case "no_model": return "metrics";
        case "metrics": return undefined;
      }
    };

    const runRuntimeLoop = async (initialState: GraphState): Promise<GraphState> => {
      let state = initialState;
      let node: RuntimeNodeName | undefined = "bootstrap";
      // No iteration cap. The model owns the stop decision. The runtime
      // loop continues until the graph routes a node to undefined
      // (which happens only after the model self-stops and the run
      // exits via metricsNode). The only external kill switch is the
      // abort signal, which the model node and tool node respect.
      while (node) {
        const update = await nodes[node](state);
        state = { ...state, ...update };
        node = nextNode(node, state);
      }
      return state;
    };

    // Register scoped cleanup for this run
    const executorInstance = executor;
    const unregisterExecutorCleanup = executorInstance
      ? registerCleanup(async () => {
          await executorInstance.cleanupBackgroundProcesses("runtime_finished");
        })
      : undefined;

    try {
      const finalState = await runRuntimeLoop({
        prompt: "",
        planState: createPlanState(),
        todoState: createTodoState(),
        runtimeBlockers: [],
        shouldCompact: false,
        currentStepIndex: 0,
        currentStepToolStartIndex: 0,
        completedStepIds: [],
        rescueWatchdog: createRescueWatchdogState(),
        toolResults: [],
        events: [],
        assistantMessage: "",
        feedback: [],
        negativeConstraints: [],
        iteration: 0,
        lastBatchFailed: false,
        completionGateAttempts: 0,
        completionGateExhausted: false,
        stuckReplanCount: 0,
        readOnlyBatchSignatures: [],
        needsReplan: false,
        done: false,
      });

      const finalBoot = finalState.boot ?? boot;
      if (!finalBoot) throw new Error("LangGraph runtime ended without boot state");

      // `verification` on the result stays explicit-request-only. Natural
      // stops are scored observationally in metricsNode (verifiedCompletion
      // considers the model's own last grounded test/build/typecheck run) —
      // the engine never runs anything extra and never forces the model to.
      // Strip model-reasoning envelopes (<think>…</think> etc.) from the
      // visible final assistant message. The reasoning stays in trajectory
      // as its own model_response events but must not bleed into the
      // user-facing summary.
      const visibleAssistantMessage = stripThinkingBlocks(finalState.assistantMessage ?? "");
      const result: RuntimeEngineResult = {
        state: finalBoot.state,
        toolResults: finalState.toolResults,
        assistantMessage: visibleAssistantMessage,
        events: finalState.events,
        trajectoryPath: this.trajectoryLogger.path,
        ...(finalState.contentFingerprint ? { contentFingerprint: finalState.contentFingerprint } : {}),
        ...(finalState.runtimeBlockers?.length ? { runtimeBlockers: finalState.runtimeBlockers } : {}),
        ...(finalState.explicitVerification ? { verification: finalState.explicitVerification } : {}),
      };
      const finalStatus = classifyRunFinalStatus(finalState as unknown as Parameters<typeof classifyRunFinalStatus>[0]);

      // ─── Context-engineering: RUN-COMPLETE ───────────────────────────────
      try {
        const ctxHooks = this.ctxHooks;
        if (ctxHooks) {
          const usedChars = JSON.stringify(finalState.toolResults ?? []).length
            + (finalState.assistantMessage ?? "").length;
          await ctxHooks.onRunComplete({
            workspaceRoot: this.input.workspaceRoot,
            runId: finalBoot.state.runId,
            sessionId: finalBoot.state.sessionId,
            traceId: finalBoot.state.runId,
            ...(finalBoot.state.namedSession ? { namedSession: finalBoot.state.namedSession } : {}),
            assistantMessage: finalState.assistantMessage ?? "",
            trajectoryLogger: this.trajectoryLogger,
            success: finalStatus === "completed",
            softCap: finalBoot.state.tokenBudget?.softCap ?? 270_000,
            usedChars,
          });
        }
      } catch { /* swallow */ }

      await persistExecutionPlanProgress(this.input.workspaceRoot, finalBoot.state.runId, {
        currentStepIndex: finalState.currentStepIndex,
        completedStepIds: finalState.completedStepIds,
        failed: finalStatus === "failed",
      });
      await persistRunResult(runContext, result, finalStatus);
      return result;
    } catch (error) {
      await persistRunFailure(runContext, error);
      // Drop any cached typed slots + the idle-compaction timer even
      // on failure; the wiring's onRunComplete path is the happy-path
      clearRunState(runContext.runId);
      throw error;
    } finally {
      unregisterExecutorCleanup?.();
      await writeLatestRunPointer(this.input.workspaceRoot, runContext);
    }
  }
}

export function selectGeneralAgentToolsForTurn(input: {
  request: AgentRequestEnvelope;
  state: Pick<GraphState, "toolResults">;
  tools: AgentToolDescriptor[];
}): AgentToolDescriptor[] {
  // Scratchpad is on-demand. Promote it onto the wire only when the user
  // prompt explicitly asks for it (eval/stress tasks). Otherwise the model
  // can still discover it via search_tools.
  let tools = input.tools;
  if (userPromptRequestsScratchpad(input.request) && !tools.some((t) => t.name === "scratchpad")) {
    const scratch = buildAgentToolDescriptor("scratchpad");
    if (scratch) tools = [...tools, scratch];
  }

  if (!detectBuildLikeTask(input.request)) return tools;

  const writeCount = input.state.toolResults.filter((result) =>
    result.ok && ["write_file", "file_edit", "edit_file", "delete_file"].includes(result.name),
  ).length;

  // Build-like tasks still get a compact fast-start surface, but keep canonical
  // tool names on the wire. The model should see and learn `file_view`,
  // `file_find`, and `file_edit` directly — no legacy aliases or
  // short-name renames (`read`/`edit`/`write`).
  if (writeCount < 20) {
    return toCanonicalBuildFastStartTools(tools);
  }
  return tools;
}

/**
 * The compact surface a build-like task starts with.
 *
 * It must contain every core tool. `renderAvailableTools` omits core names from
 * the deferred inventory on the assumption that they are already on the wire —
 * so narrowing a core tool off the wire here would hide it in *both*
 * directions: absent from the tool list, and absent from the list of tools the
 * model is told it can discover.
 *
 * **Everything else the caller passed in is kept.** This started as a fixed
 * name list — core, plus `file_find`, plus `scratchpad` if the prompt asked —
 * which quietly made the fast-start surface the *only* surface for the whole
 * run. `selectGeneralAgentToolsForTurn` calls this on every turn until the
 * twentieth successful write, so for the entire early phase of a build task it
 * rebuilt the tool list from scratch and discarded every promotion the model
 * had earned. A model could call `search_tools`, be told `create_checkpoint`
 * was now unlocked, see it listed in `# Available tools`... and never get its
 * schema, on that turn or any turn after, until it had written twenty files.
 * The observed result is a model that re-searches for the same tool four times,
 * concludes the unlock is broken, tries calling it blind, and gives up.
 *
 * So the narrowing is a *reorder and a floor*, not a filter: the core names
 * lead (they are the ones a build task reaches for first), and the rest follow
 * in their original order. Dropping something the caller already decided to
 * attach is never this function's business — `disabledTools` and the caller
 * itself are the only things allowed to withhold a tool.
 */
function toCanonicalBuildFastStartTools(tools: AgentToolDescriptor[]): AgentToolDescriptor[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const leading: string[] = [...CORE_TOOL_NAMES, "file_find"];
  const ordered = [
    ...leading,
    // Promoted or otherwise attached tools, in the order the caller had them,
    // minus anything already placed above.
    ...tools.map((tool) => tool.name).filter((name) => !leading.includes(name)),
  ];
  return ordered
    .map((name) => byName.get(name))
    .filter((tool): tool is AgentToolDescriptor => Boolean(tool));
}

export function selectMainAgentMaxTokensForTurn(input: {
  request: AgentRequestEnvelope;
  state: Pick<GraphState, "toolResults">;
}): number {
  if (!detectBuildLikeTask(input.request)) return 32_000;
  const writeCount = input.state.toolResults.filter((result) =>
    result.ok && ["write_file", "file_edit", "edit_file", "delete_file"].includes(result.name),
  ).length;
  // Large build tasks need more than the old 8192 cap, but an all-at-once
  // 32k first response can exceed the provider's request timeout before any
  // tool result lands. Start with a 16k budget while the repository is empty,
  // then allow 32k once the agent has momentum.
  return writeCount < 20 ? 16_000 : 32_000;
}

function renderToolResultSnippet(result: ToolResult): string {
  return JSON.stringify(renderToolResultForModel(result)).slice(0, 9000);
}

/**
 * Push `plan.updated` / `todo.updated` events when an advisory call actually
 * changed state. Only a reference change counts: `applyAdvisoryToolCalls`
 * returns the input references untouched when it changed nothing, so an
 * unchanged checklist emits no event and the UI never re-renders for a no-op.
 */
async function emitPlanTodoDelta(
  sink: RuntimeEventSink | undefined,
  prevPlan: PlanState | undefined,
  nextPlan: PlanState | undefined,
  prevTodo: TodoState | undefined,
  nextTodo: TodoState | undefined,
): Promise<void> {
  if (!sink) return;
  if (nextPlan !== prevPlan && nextPlan?.steps) {
    await emitRuntimeEvent(sink, { type: "plan.updated", steps: nextPlan.steps });
  }
  if (nextTodo !== prevTodo) {
    await emitRuntimeEvent(sink, { type: "todo.updated", items: nextTodo?.items ?? [] });
  }
}

function applyAdvisoryToolCalls(
  state: Pick<GraphState, "planState" | "todoState">,
  calls: AdvisoryToolCall[],
): Partial<Pick<GraphState, "planState" | "todoState" | "toolResults">> {
  if (calls.length === 0) return {};
  let planState = state.planState;
  let todoState = state.todoState;
  const toolResults: ToolResult[] = [];

  for (const call of calls) {
    if (call.name === "update_plan") {
      const args = call.args;
      if (args.candidate && typeof args.markdown === "string") {
        planState = {
          ...planState,
          candidates: [args.markdown, ...planState.candidates.filter((item) => item !== args.markdown)],
        };
      } else if (typeof args.activePlanMarkdown === "string") {
        planState = applyCandidatePlan(planState, args.activePlanMarkdown);
      } else if (typeof args.markdown === "string") {
        planState = applyCandidatePlan(planState, args.markdown);
      }
      if (typeof args.activePlanMarkdown === "string") {
        planState = { ...planState, activeMarkdown: args.activePlanMarkdown };
      }
      if (Array.isArray(args.steps)) {
        // Typed steps become the canonical plan; merge with any existing
        // activeMarkdown so the cockpit renders both.
        planState = setPlanSteps(planState, args.steps);
      }
      toolResults.push(makeAdvisoryToolResult(call, {
        adopted: !args.candidate || Boolean(args.activePlanMarkdown),
        candidate: Boolean(args.candidate),
        candidateCount: planState.candidates.length,
        ...(planProgress(planState) ? { stepProgress: planProgress(planState) } : {}),
      }));
      continue;
    }

    const args = call.args;
    todoState = args.append ? todoState : createTodoState();
    for (const item of args.items) {
      // `updateTodoItem` accepts the new status/priority/evidence fields and
      // also de-duplicates by id, so successive `update_todo` calls merge
      // cleanly into a single working memory.
      todoState = updateTodoItem(todoState, {
        id: item.id,
        content: item.content,
        ...(item.status ? { status: item.status } : {}),
        ...(item.priority ? { priority: item.priority } : {}),
        ...(item.evidence ? { evidence: item.evidence } : {}),
        ...(item.done !== undefined ? { status: item.done ? "completed" : "pending" } : {}),
      });
    }
    toolResults.push(makeAdvisoryToolResult(call, {
      itemCount: todoState.items.length,
      append: Boolean(args.append),
    }));
  }

  return { planState, todoState, toolResults };
}

function makeAdvisoryToolResult(call: { id: string; name: string; args: Record<string, unknown> }, output: unknown): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    ok: true,
    durationMs: 0,
    args: call.args,
    output,
  };
}

function normalizeExecutableToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((call) => !["advance_step", "update_plan", "update_todo"].includes(call.name));
}

/**
 * Split a batch into the calls a thread's tool policy refuses and the ones it
 * allows, turning each refusal into a failed `ToolResult`.
 *
 * Exactly one result per model-emitted call is the invariant the scheduler and
 * the transcript both rely on, so a blocked call has to produce its own result
 * here rather than being filtered out silently — otherwise the batch would
 * come back short and the missing result would be attributed to a sibling.
 */
function partitionByToolPolicy(
  toolCalls: ToolCall[],
  disabledTools: ReadonlySet<string>,
): [ToolResult[], ToolCall[]] {
  if (disabledTools.size === 0) return [[], toolCalls];
  const blocked: ToolResult[] = [];
  const allowed: ToolCall[] = [];
  for (const call of toolCalls) {
    if (!disabledTools.has(call.name)) {
      allowed.push(call);
      continue;
    }
    blocked.push({
      toolCallId: call.id,
      name: call.name,
      ok: false,
      durationMs: 0,
      args: call.args,
      error: {
        code: "tool_disabled",
        message:
          `The tool '${call.name}' is disabled for this thread by its settings. ` +
          "It is not available in this conversation; use another tool or tell the user why this one is needed.",
      },
    });
  }
  return [blocked, allowed];
}



export function isReadOnlyToolResult(result: ToolResult): boolean {
  return ["file_view", "file_find", "list_directory", "grep_search", "skim_file", "inspect_env", "web_search", "web_fetch"].includes(result.name);
}
function isMutationOrProducerResult(result: ToolResult): boolean {
  if (["write_file", "file_edit", "edit_file", "delete_file"].includes(result.name)) return true;
  if (result.name !== "bash") return false;
  const command = getToolResultCommand(result);
  return isMutatingShellCommand(command) || isProducerOrVerificationCommand(command);
}
function updateReadOnlyBatchSignatures(input: {
  previous: string[];
  split?: SplitToolCalls | undefined;
  lastBatchFailed: boolean;
}): string[] {
  const split = input.split;
  if (!split || split.advancementSignal) return [];
  if (input.lastBatchFailed) return input.previous;
  const signature = makeReadOnlyBatchSignature(split.executableToolCalls);
  if (!signature) return [];
  return [...input.previous, signature].slice(-8);
}

function makeReadOnlyBatchSignature(toolCalls: ToolCall[]): string | undefined {
  if (toolCalls.length === 0) return undefined;
  const signatures = toolCalls.map(makeLowInformationToolCallSignature);
  if (signatures.some((signature) => !signature)) return undefined;
  return signatures.sort().join("|");
}

function isReadOnlyInspectionStepDone(step: ExecutionPlanStep | undefined, split: SplitToolCalls | undefined): boolean {
  if (!step || !split) return false;
  if (step.type !== "inspect" && step.type !== "review") return false;
  if (split.executableToolCalls.length === 0) return false;
  return split.executableToolCalls.every((call) => Boolean(makeLowInformationToolCallSignature(call)));
}
function getRepeatedDiagnosticFailure(results: ToolResult[]):
  | { signature: string; command: string; errorLogs: string; filesHint: string[] }
  | undefined {
  const diagnosticFailures = results
    .filter((result) => !result.ok && isPatchWorthyDiagnosticFailure(result))
    .slice(-8);
  if (diagnosticFailures.length === 0) return undefined;
  const latest = diagnosticFailures.at(-1)!;
  const latestSignature = makeDiagnosticFailureSignature(latest);
  const repeatedCount = diagnosticFailures.filter((result) => makeDiagnosticFailureSignature(result) === latestSignature).length;
  const recentFailedEdits = results
    .slice(-10)
    .filter((result) => !result.ok && ["file_edit", "edit_file", "write_file"].includes(result.name)).length;
  if (repeatedCount < 2 && recentFailedEdits < 2) return undefined;
  const related = diagnosticFailures.filter((result) => makeDiagnosticFailureSignature(result) === latestSignature).slice(-3);
  const errorLogs = related.map((result) => renderToolResultSnippet(result)).join("\n\n---\n\n").slice(0, 9000);
  const filesHint = uniqueStrings(related.flatMap(extractFilePathsFromFailure).filter((file) => !isGeneratedOrBuildPath(file))).slice(0, 8);
  return {
    signature: latestSignature,
    command: getToolResultCommand(latest),
    errorLogs,
    filesHint,
  };
}

export function isPatchWorthyDiagnosticFailure(result: ToolResult): boolean {
  if (result.name !== "bash") return false;
  if (isNoDiagnosticShellExitFailure(result)) return false;
  const command = getToolResultCommand(result);
  const message = result.error?.message ?? "";
  if (!isBuildCommand(command) && !isTestCommand(command) && !isVerificationLikeCommand(command) && !isBuildArtifactRuntimeCommand(command)) return false;
  if (/cat .*CMake(?:Error|Output)\.log|ls -la .*\/build\/|test -f .*\/build\//i.test(command)) return false;
  return isCompileOrBuildError(message) || /AssertionError|Traceback|FAIL|failed|error:|Exception|No such file or directory|not found/i.test(message);
}

function makeDiagnosticFailureSignature(result: ToolResult): string {
  const commandClass = classifyDiagnosticCommand(getToolResultCommand(result));
  const message = result.error?.message ?? "";
  const firstDiagnostic = extractFirstDiagnosticLine(message);
  return `${commandClass}:${stableHash(firstDiagnostic)}`;
}

function classifyDiagnosticCommand(command: string): string {
  if (isBuildCommand(command)) return "build";
  if (isTestCommand(command)) return "test";
  if (isBuildArtifactRuntimeCommand(command)) return "runtime-artifact";
  if (isVerificationLikeCommand(command)) return "verification";
  return "command";
}

function extractFirstDiagnosticLine(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (
    lines.find((line) => /(?:error:|fatal error:|undefined reference|No rule to make target|CMake Error|AssertionError|Traceback|FAIL|Exception)/i.test(line)) ??
    lines.at(-1) ??
    message
  ).slice(0, 1000);
}


export function getUnresolvedTaskContractVerificationBlocker(results: ToolResult[]): string | undefined {
  const window = results.slice(-100);
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const failure = window[index];
    if (!failure || !isStrictTaskContractFailureResult(failure)) continue;
    const failingCommand = getToolResultCommand(failure);
    const laterResults = window.slice(index + 1);
    if (laterResults.some((result) => doesSuccessfulCheckClearStrictFailure(failure, result))) continue;
    const diagnostic = extractFirstDiagnosticLine(getToolResultText(failure)).replace(/\s+/g, " ").trim().slice(0, 360);
    return (
      `Completion is blocked because a strict task-contract check still fails and no equivalent or broader check has passed afterward. ` +
      `Failed check: '${normalizeDiagnosticCommand(failingCommand).slice(0, 500)}'. ` +
      `${diagnostic ? `Latest diagnostic: ${diagnostic}. ` : ""}` +
      "Do not replace an assertion, expected-value comparison, hash/content check, or failing test with a print-only or weaker check. Repair the implementation, then rerun the same strict check or a broader authoritative suite."
    );
  }
  return undefined;
}

function isStrictTaskContractFailureResult(result: ToolResult): boolean {
  if (result.ok || result.name !== "bash" || isInternalGuardBlockedResult(result)) return false;
  const command = getToolResultCommand(result);
  const text = `${command}\n${getToolResultText(result)}`;
  if (isBuildCommand(command) && !isTestCommand(command) && !isVerificationLikeCommand(command)) return false;
  return (
    isTestCommand(command) ||
    isVerificationLikeCommand(command) ||
    isStrictArtifactCheckCommand(command) ||
    /\b(?:assert(?:ion)?|expected|actual|mismatch|hash|diff(?:er)?|does not match|wrong output|incorrect output|FAILED)\b/i.test(text)
  );
}

function doesSuccessfulCheckClearStrictFailure(failure: ToolResult, result: ToolResult): boolean {
  if (!result.ok || result.name !== "bash" || isSemanticFailedCheckResult(result)) return false;
  const failingCommand = getToolResultCommand(failure);
  const successCommand = getToolResultCommand(result);
  const strictSuccess = isSuccessfulStrictVerificationResult(result, successCommand);
  if (!strictSuccess && !isNaturalFailureReproductionSuccess(failure, successCommand)) return false;
  if (normalizeTaskContractCommand(successCommand) === normalizeTaskContractCommand(failingCommand)) return true;
  if (isTestCommand(failingCommand) && isBroadTestCommandForFamily(successCommand, testCommandFamily(failingCommand))) return true;
  if (isNaturalFailureReproductionSuccess(failure, successCommand)) return true;
  return false;
}

function isNaturalFailureReproductionSuccess(failure: ToolResult, successCommand: string): boolean {
  const failureText = getToolResultText(failure);
  for (const match of failureText.matchAll(/(?:No module named|Cannot find module|ModuleNotFoundError:?\s*(?:No module named)?|ImportError:?\s*(?:cannot import name)?)\s*['"]?([A-Za-z0-9_.-]+)/gi)) {
    const moduleName = match[1]?.split(".")[0];
    if (moduleName && new RegExp(String.raw`\b(?:import|require\s*\(|from)\s*['"]?${escapeRegExp(moduleName)}\b`, "i").test(successCommand)) {
      return true;
    }
  }
  for (const match of failureText.matchAll(/(?:No such file or directory|FileNotFoundError|missing artifact)[^'"\n]*['"]([^'"]+)['"]/gi)) {
    const filePath = match[1];
    if (filePath && successCommand.includes(filePath) && /\b(?:test\s+-[feds]|cat|open\s*\(|readFile|read_text|stat|ls)\b/i.test(successCommand)) {
      return true;
    }
  }
  const failingHost = failureText.match(/(?:Could not resolve host|Failed to resolve|host=|host='|host=")([A-Za-z0-9_.-]+)/i)?.[1];
  if (failingHost && successCommand.includes(failingHost) && /\b(?:curl\s+-f|wget|nc|netcat|requests\.|http\.|https\.)\b/i.test(successCommand)) {
    return true;
  }
  return false;
}

function normalizeTaskContractCommand(command: string): string {
  return normalizeDiagnosticCommand(command)
    .replace(/\/tmp\/reaper-tbench-[^/\s'"]+/g, "<workspace>")
    .replace(/^\s*cd\s+(['"]?)[^'";&|]+\1\s*&&\s*/i, "")
    .replace(/\s*\|\s*(?:tail|head)\b[\s\S]*$/i, "")
    .trim();
}

function testCommandFamily(command: string): string {
  const normalized = normalizeVerificationCommand(command);
  if (/\bpytest\b/i.test(normalized)) return "pytest";
  if (/\bnode\s+--test\b/i.test(normalized)) return "node-test";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i.test(normalized)) return "js-test";
  if (/\b(?:jest|vitest|mocha|playwright|cypress)\b/i.test(normalized)) return "js-test";
  if (/\bgo\s+test\b/i.test(normalized)) return "go-test";
  if (/\bcargo\s+test\b/i.test(normalized)) return "cargo-test";
  if (/\b(?:mvn|gradle|gradlew)\s+test\b/i.test(normalized)) return "jvm-test";
  return "other";
}

function isBroadTestCommandForFamily(command: string, family: string): boolean {
  if (family === "other" || testCommandFamily(command) !== family) return false;
  const normalized = normalizeTaskContractCommand(command);
  if (family === "pytest") {
    return /^pytest(?:\s+-[A-Za-z0-9-]+(?:=\S+)?)?\s*$/i.test(normalized) || /^python3?\s+-m\s+pytest(?:\s+-[A-Za-z0-9-]+(?:=\S+)?)?\s*$/i.test(normalized);
  }
  if (family === "go-test") return /\bgo\s+test\s+(?:-[A-Za-z0-9=.-]+\s+)*\.\/\.\.\.(?:\s|$)/i.test(normalized);
  if (family === "cargo-test") return /^cargo\s+test(?:\s+--(?:workspace|all|all-targets))*\s*$/i.test(normalized);
  if (family === "js-test") return /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s+--)?\s*$/i.test(normalized);
  if (family === "node-test") return /^node\s+--test\s*$/i.test(normalized);
  if (family === "jvm-test") return /\b(?:mvn|gradle|gradlew)\s+test\s*$/i.test(normalized);
  return false;
}

function getCrossOutputCountRegressionBlocker(results: ToolResult[]): string | undefined {
  let maxObservedMarker = 0;
  let observedLine = "";
  let maxReportedCount = 0;
  for (const result of results.slice(-24)) {
    if (result.name !== "bash" || !result.ok) continue;
    const lines = getToolResultText(result).split(/\r?\n/);
    const reportedCount = extractReportedPopulationCount(lines);
    if (reportedCount !== undefined && reportedCount > maxReportedCount) maxReportedCount = reportedCount;
    const marker = extractObservedNumericMarker(lines);
    if (marker && marker.value > maxObservedMarker) {
      maxObservedMarker = marker.value;
      observedLine = marker.line;
    }
  }
  if (maxObservedMarker > 0 && maxReportedCount > 0 && maxReportedCount < maxObservedMarker) {
    return `Completion is blocked because the reported output count (${maxReportedCount}) is lower than an observed numeric marker (${maxObservedMarker}: ${observedLine}). Reconcile the source evidence and rerun the producer/check before completing.`;
  }
  return undefined;
}

function extractObservedNumericMarker(lines: string[]): { value: number; line: string } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const next = lines[index + 1] ?? "";
    const match = /^([1-9]\d{1,8})$/.exec(line);
    if (!match || !/^\s+\S/.test(next)) continue;
    return { value: Number.parseInt(match[1]!, 10), line };
  }
  return undefined;
}

function extractReportedPopulationCount(lines: string[]): number | undefined {
  const counts: number[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const found = /^(?:Found|Loaded|Read|Processed|Matched|Extracted|Generated|Created|Wrote|Produced)\s+([0-9][0-9,]*)\s+[A-Za-z]/i.exec(line);
    if (found) counts.push(Number.parseInt(found[1]!.replace(/,/g, ""), 10));
    const total = /^(?:Total|Number of)\s+[A-Za-z][A-Za-z0-9 _./()%'-]{2,100}:\s*([0-9][0-9,]*)\b/i.exec(line);
    if (total && !/\b(?:unique|distinct|deduplicated)\b/i.test(line)) {
      counts.push(Number.parseInt(total[1]!.replace(/,/g, ""), 10));
    }
  }
  return counts.length ? Math.max(...counts) : undefined;
}

function closeClearedBackfilledRuntimeTasks(
  runId: string,
  facts: RuntimeBlockingFacts,
  hasStrictVerification: boolean,
  semanticOutputRecovery: boolean,
): void {
  if (!facts.successfulProducerOrVerificationAfterBlocker && !semanticOutputRecovery) return;
  if (facts.missingArtifacts.length > 0 || facts.failedBuildOrCompile.length > 0) return;
  if (!semanticOutputRecovery && facts.failedRuntimeOrVerification.length > 0) return;
  for (const task of listSessionTasks(undefined, runId)) {
    if (task.status === "completed" || !isReaperBackfilledRuntimeTask(task.subject)) continue;
    if (/\b(?:strict final verification|run strict final verification)\b/i.test(task.subject) && !hasStrictVerification) continue;
    updateSessionTask({ taskId: task.id, status: "completed" }, runId);
  }
}

function hasSemanticOutputRecovery(results: ToolResult[]): boolean {
  let sawSemanticFailure = false;
  for (const result of results.slice(-24)) {
    if (isSemanticFailedCheckResult(result)) {
      sawSemanticFailure = true;
      continue;
    }
    if (sawSemanticFailure && hasNontrivialSemanticCleanShellOutput(result)) return true;
  }
  return false;
}

function reconcileBackfilledRuntimeTasksWithEvidence(runId: string, results: ToolResult[]): void {
  const openTasks = listSessionTasks(undefined, runId).filter((task) => task.status !== "completed");
  if (openTasks.length === 0) return;
  const facts = deriveRuntimeBlockingFacts(results);
  const hasStrictVerification = hasRecentSuccessfulLocalVerification(results);
  const hasAnyClearingEvidence = facts.successfulProducerOrVerificationAfterBlocker || hasStrictVerification;

  for (const task of openTasks) {
    if (!isReaperBackfilledRuntimeTask(task.subject)) continue;
    const text = `${task.subject}\n${task.description}`.toLowerCase();
    const resolved =
      (/\b(?:strict final verification|run strict final verification)\b/.test(text) && hasStrictVerification) ||
      (/\b(?:verification failure|failed check|verification blocker|runtime or verification failure)\b/.test(text) &&
        hasAnyClearingEvidence &&
        facts.failedRuntimeOrVerification.length === 0) ||
      (/\bmissing artifact\b/.test(text) && facts.missingArtifacts.length === 0 && hasAnyClearingEvidence) ||
      (/\b(?:build|compile)\b/.test(text) && facts.failedBuildOrCompile.length === 0 && hasAnyClearingEvidence);
    if (resolved) {
      updateSessionTask({ taskId: task.id, status: "completed" }, runId);
    }
  }
}

function isReaperBackfilledRuntimeTask(subject: string): boolean {
  return /^(?:Run strict final verification|Resolve verification failure|Backfill failed check|Create or validate missing artifact|Fix build or compile failure|Fix runtime or verification failure|Fix build blocker|Fix verification blocker)\b/i.test(
    subject,
  );
}

function backfillRuntimeBlockerTasks(input: { runId: string; toolResults: ToolResult[]; blocker: string }): string[] {
  const facts = deriveRuntimeBlockingFacts(input.toolResults);
  const candidates: Array<{ subject: string; description: string }> = [];
  for (const artifact of facts.missingArtifacts) {
    candidates.push({
      subject: `Create or validate missing artifact ${shortTaskToken(artifact)}`,
      description:
        `Runtime evidence shows the required artifact is missing: ${artifact}. Produce it through the task workflow, then run a strict content/path check that proves it exists and matches the expected contract.`,
    });
  }
  for (const failure of facts.failedBuildOrCompile) {
    candidates.push({
      subject: `Fix build or compile failure ${shortTaskToken(failure)}`,
      description:
        `A build/compile blocker remains unresolved: ${failure}. Repair the cited source/config issue and rerun the narrowest relevant build or compile check successfully.`,
    });
  }
  for (const failure of facts.failedRuntimeOrVerification) {
    candidates.push({
      subject: `Fix runtime or verification failure ${shortTaskToken(failure)}`,
      description:
        `Runtime/verification evidence still fails: ${failure}. Read the failing output, repair the exact behavior/artifact mismatch, and rerun a strict check that exercises the final deliverable.`,
    });
  }
  if (candidates.length === 0 && /unverified|no subsequent successful/i.test(input.blocker)) {
    candidates.push({
      subject: "Run strict final verification",
      description:
        `${input.blocker} Run a real task-local verifier or a narrow assertion/content check that exercises the deliverable and proves the exact expected content, shape, and behavior.`,
    });
  }
  return createMissingSessionTasks(input.runId, candidates);
}

function backfillVerificationFailureTasks(input: {
  runId: string;
  verification: NonNullable<RuntimeEngineResult["verification"]>;
  toolResults: ToolResult[];
}): string[] {
  const output = [
    input.verification.command ?? "",
    ...(input.verification.failureClasses ?? []),
    ...(input.verification.feedback ?? []),
    ...(input.verification.negativeConstraints ?? []),
  ].join("\n");
  const classified = classifyVerificationOutput(output);
  const candidates: Array<{ subject: string; description: string }> = [];
  for (const failureClass of uniqueStrings([...(input.verification.failureClasses ?? []), ...classified.classes])) {
    candidates.push({
      subject: `Resolve verification failure ${failureClass}`,
      description:
        `Verification failed with class '${failureClass}'. ${classified.evidence.join(" ")} ${classified.repairStrategy} Rerun the exact failing verification or a stricter equivalent after repair.`,
    });
  }
  for (const fact of classified.facts.slice(0, 6)) {
    candidates.push({
      subject: `Backfill failed check ${shortTaskToken(fact)}`,
      description:
        `Failure fact from verification: ${fact}. Repair the underlying artifact/behavior and prove it with command-backed evidence before retrying completion.`,
    });
  }
  candidates.push(
    ...backfillRuntimeBlockerTaskCandidates(input.toolResults),
  );
  return createMissingSessionTasks(input.runId, candidates);
}

function backfillRuntimeBlockerTaskCandidates(toolResults: ToolResult[]): Array<{ subject: string; description: string }> {
  const facts = deriveRuntimeBlockingFacts(toolResults);
  return [
    ...facts.missingArtifacts.map((artifact) => ({
      subject: `Create or validate missing artifact ${shortTaskToken(artifact)}`,
      description:
        `A recent failing tool result expected '${artifact}' but it is absent. Produce the artifact and verify its exact path/content with a strict command.`,
    })),
    ...facts.failedBuildOrCompile.map((failure) => ({
      subject: `Fix build blocker ${shortTaskToken(failure)}`,
      description: `A build or compile failure remains unresolved: ${failure}. Patch the root cause and rerun the relevant build/compile command.`,
    })),
    ...facts.failedRuntimeOrVerification.map((failure) => ({
      subject: `Fix verification blocker ${shortTaskToken(failure)}`,
      description: `A runtime or verification failure remains unresolved: ${failure}. Repair the behavior/artifact mismatch and rerun a strict verifier.`,
    })),
  ];
}

function createMissingSessionTasks(runId: string, candidates: Array<{ subject: string; description: string }>): string[] {
  const existing = new Set(
    listSessionTasks(undefined, runId)
      .filter((task) => task.status !== "completed")
      .map((task) => normalizeTaskSubject(task.subject)),
  );
  const created: string[] = [];
  for (const candidate of candidates) {
    const subject = candidate.subject.slice(0, 140);
    const key = normalizeTaskSubject(subject);
    if (!key || existing.has(key)) continue;
    const task = createSessionTask(
      {
        subject,
        description: candidate.description.slice(0, 1200),
        status: "pending",
      },
      runId,
    );
    existing.add(key);
    created.push(task.id);
    if (created.length >= 8) break;
  }
  return created;
}

function normalizeTaskSubject(subject: string): string {
  return subject.toLowerCase().replace(/\s+/g, " ").trim();
}

function shortTaskToken(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "unknown";
  return compact.length <= 48 ? compact : `${compact.slice(0, 45)}...`;
}

function getToolResultText(result: ToolResult): string {
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  const content = typeof output.content === "string" ? output.content : "";
  const unnumberedContent = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+:\s?/, ""))
    .join("\n");
  const message = result.error?.message ?? "";
  return `${stdout}\n${stderr}\n${content}\n${unnumberedContent}\n${message}`.trim();
}

export function getSemanticFailureSignal(result: ToolResult): SemanticFailureSignal | undefined {
  if (result.name !== "bash") return undefined;
  const signal = detectSemanticFailureText(getToolResultText(result));
  if (!signal) return undefined;
  const command = getToolResultCommand(result);
  if (isProducerOrVerificationCommand(command) || isCheckLikeShellCommand(command) || isTaskAcceptanceCommand(command)) {
    return signal;
  }
  if (/explicit (?:failed status|match=false|success=false)|assertion|mismatch|traceback|nonzero/i.test(signal.reason)) {
    return signal;
  }
  return undefined;
}

export function isSemanticFailedCheckResult(result: ToolResult): boolean {
  return Boolean(getSemanticFailureSignal(result));
}



function isWeakPrintOnlyValidationResult(result: ToolResult, step: ExecutionPlanStep): boolean {
  if (!result.ok || result.name !== "bash") return false;
  const command = getToolResultCommand(result);
  if (isSuccessfulStrictVerificationResult(result, command) || isBuildCommand(command) || isTestCommand(command)) return false;
  const summary = getToolResultSummary(result);
  const stepText = renderStepText(step);
  const intentText = `${command}\n${summary}\n${stepText}`;
  if (!/\b(?:verify|validate|check|assert|expected|actual|match|compare|hash|diff|equals?)\b/i.test(intentText)) return false;
  const outputText = getToolResultText(result);
  if (!outputText.trim()) return false;
  if (/\b(?:PASS|PASSED|SUCCESS|OK)\b/i.test(outputText) && /\b(?:assert|expected|matched?|verified)\b/i.test(outputText)) return false;
  return true;
}

function isReadOnlyPlanStep(step: ExecutionPlanStep | undefined): boolean {
  if (!step) return false;
  const type = step.type ?? "command";
  return type === "inspect" || type === "review" || type === "finalize";
}

function isImplementationLikeStep(step: ExecutionPlanStep): boolean {
  const text = [
    step.id,
    step.title,
    step.instructions,
    step.suggestedImplementation ?? "",
    step.testGuidance ?? "",
    ...(step.successCriteria ?? []),
  ].join("\n").toLowerCase();
  return /\b(write|create|add|implement|replace|generate|produce|save|output)\b/.test(text);
}

function collectExplicitStepFileReferences(step: ExecutionPlanStep, results: ToolResult[]): string[] {
  const stepText = [
    step.id,
    step.title,
    step.instructions,
    step.suggestedImplementation ?? "",
    step.testGuidance ?? "",
    ...(step.successCriteria ?? []),
  ].join("\n");
  const paths = new Set<string>();
  const fileRefPattern =
    /(?<![\w.-])(?:\.{1,2}\/|\/app\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,12}(?![\w.-])/g;
  for (const match of stepText.matchAll(fileRefPattern)) {
    const normalized = normalizeWorkspaceRelativeReference(match[0]);
    if (normalized && isUsefulExplicitFileReference(normalized)) paths.add(normalized);
  }
  for (const result of results.slice(-12)) {
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    if (result.ok && ["write_file", "file_edit", "edit_file"].includes(result.name) && typeof args.path === "string") {
      const normalized = normalizeWorkspaceRelativeReference(args.path);
      if (normalized && stepText.includes(normalized) && isUsefulExplicitFileReference(normalized)) {
        paths.add(normalized);
      }
    }
  }
  return [...paths].slice(0, 8);
}

function normalizeWorkspaceRelativeReference(reference: string): string | undefined {
  const normalized = reference.replace(/\\/g, "/").replace(/^['"`]+|['"`:),.;]+$/g, "");
  const withoutApp = normalized.startsWith("/app/") ? normalized.slice("/app/".length) : normalized;
  const withoutDot = withoutApp.replace(/^\.\//, "");
  if (!withoutDot || withoutDot.startsWith("../") || withoutDot.includes("/../")) return undefined;
  return withoutDot;
}

function isUsefulExplicitFileReference(relativePath: string): boolean {
  if (/^(?:scratchpad|node_modules|\.git|build|dist|coverage)\//i.test(relativePath)) return false;
  return !/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(relativePath);
}

function readWorkspaceTextIfExists(workspaceRoot: string, relativePath: string): string | undefined {
  const target = path.resolve(workspaceRoot, relativePath);
  if (!target.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`) && target !== path.resolve(workspaceRoot)) return undefined;
  try {
    if (!existsSync(target) || !statSync(target).isFile()) return undefined;
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function isLikelyPlaceholderSource(content: string): boolean {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  const hasPlaceholderMarker = /\b(?:stub|placeholder|not implemented)\b/i.test(compact);
  const hasTodoMarker = /\btodo\b/i.test(compact);
  const hasRealCodeShape = /[#]\s*include\b|\b(?:class|struct|enum|union|namespace|function|def|fn|impl|func|package|import|export|const|let|var)\b|[;{}]/i.test(
    compact,
  );
  if (hasPlaceholderMarker && (compact.length < 1200 || !hasRealCodeShape)) return true;
  if (hasTodoMarker && compact.length < 240 && !hasRealCodeShape) return true;
  if (/int\s+main\s*\([^)]*\)\s*\{\s*(?:std::cout\s*<<[^;]+;\s*)?return\s+0\s*;\s*\}/s.test(content)) return true;
  if (/\b(?:pass|return\s+null|return\s+undefined|throw\s+new\s+Error\s*\(\s*["']not implemented)/i.test(compact) && compact.length < 500) {
    return true;
  }
  return false;
}

function deriveRuntimeBlockingFacts(results: ToolResult[]): RuntimeBlockingFacts {
  const recent = results.slice(-24);
  const lastBlockerIndex = findLastIndexCompat(recent, isRuntimeBlockingResult);
  const lastVerificationSuccessIndex = findLastRuntimeBlockerClearingSuccessIndex(recent, lastBlockerIndex);
  const blockingFailures = recent.filter(isRuntimeBlockingResult);
  const activeBlockers = lastBlockerIndex >= 0 && lastVerificationSuccessIndex > lastBlockerIndex ? [] : blockingFailures;
  const unresolvedMissingArtifacts =
    lastBlockerIndex >= 0 && lastVerificationSuccessIndex > lastBlockerIndex
      ? []
      : uniqueStrings(blockingFailures.flatMap(extractMissingArtifactPaths))
          .filter((artifact) => !hasSuccessfulArtifactValidationAfter(recent, artifact, lastBlockerIndex))
          .slice(0, 8);
  return {
    missingArtifacts: unresolvedMissingArtifacts,
    failedBuildOrCompile: uniqueStrings(
      activeBlockers
        .filter((result) => result.name === "bash" && (isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(result.error?.message ?? "")))
        .map((result) => summarizeToolFailure(result)),
    ).slice(0, 6),
    failedRuntimeOrVerification: uniqueStrings(
      activeBlockers
        .filter((result) => !isBuildCommand(getToolResultCommand(result)) && isRuntimeOrVerificationFailure(result))
        .map((result) => summarizeToolFailure(result)),
    ).slice(0, 6),
    successfulProducerOrVerificationAfterBlocker: lastBlockerIndex >= 0 && lastVerificationSuccessIndex > lastBlockerIndex,
  };
}

function findLastRuntimeBlockerClearingSuccessIndex(recent: ToolResult[], lastBlockerIndex: number): number {
  const blocker = lastBlockerIndex >= 0 ? recent[lastBlockerIndex] : undefined;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const result = recent[index]!;
    if (lastBlockerIndex >= 0 && index <= lastBlockerIndex) break;
    if (isRuntimeBlockerClearingSuccess(blocker, result)) return index;
  }
  return -1;
}

function isRuntimeBlockerClearingSuccess(blocker: ToolResult | undefined, result: ToolResult): boolean {
  if (!result.ok || result.name !== "bash") return false;
  if (isSemanticFailedCheckResult(result)) return false;
  const command = getToolResultCommand(result);
  if (isSuccessfulStrictVerificationResult(result, command)) return true;
  const semantic = classifyShellCommandSemantics(command);
  if (semantic.kind === "producer" && isProducerOrVerificationCommand(command)) return true;
  if (blocker && isSemanticFailedCheckResult(blocker) && hasNontrivialSemanticCleanShellOutput(result)) return true;
  return Boolean(blocker && isSameRuntimeFamilyRecovery(blocker, result));
}

function hasNontrivialSemanticCleanShellOutput(result: ToolResult): boolean {
  if (!result.ok || result.name !== "bash") return false;
  if (isSemanticFailedCheckResult(result) || hasPlaceholderShellOutput(result)) return false;
  const text = getToolResultText(result);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 3 && lines.some((line) => /\d/.test(line))) return true;
  return text.replace(/\s+/g, " ").trim().length >= 160;
}

function isSameRuntimeFamilyRecovery(blocker: ToolResult, result: ToolResult): boolean {
  if (blocker.name !== "bash" || result.name !== "bash") return false;
  if (!isRuntimeAvailabilityFailure(blocker)) return false;
  const blockerFamily = getPrimaryShellExecutableFamily(getToolResultCommand(blocker));
  const resultFamily = getPrimaryShellExecutableFamily(getToolResultCommand(result));
  if (!blockerFamily || blockerFamily !== resultFamily) return false;
  const semantic = classifyShellCommandSemantics(getToolResultCommand(result));
  return semantic.kind !== "inspect" && semantic.kind !== "destructive" && semantic.kind !== "background_server";
}

function isRuntimeAvailabilityFailure(result: ToolResult): boolean {
  const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
  return /\b(?:command not found|not recognized as|No module named|ModuleNotFoundError|ImportError|Cannot find module|missing dependency|package [^\n]+ not found|library [^\n]+ not found|shared object file)\b/i.test(
    text,
  );
}

function getPrimaryShellExecutableFamily(command: string): string {
  for (const segment of splitUnquotedShellSegments(command)) {
    const words = parseShellWords(segment);
    if (words.length === 0) continue;
    let index = 0;
    if (words[index] === "cd") continue;
    if (words[index] === "env") index += 1;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
    const executable = words[index];
    if (!executable) continue;
    const base = path.basename(executable).replace(/\.exe$/i, "").toLowerCase();
    if (/^python\d*(?:\.\d+)?$/.test(base)) return "python";
    if (base === "nodejs") return "node";
    return base;
  }
  return "";
}

function hasSuccessfulArtifactValidationAfter(results: ToolResult[], artifact: string, blockerIndex: number): boolean {
  if (blockerIndex < 0) return false;
  return results.slice(blockerIndex + 1).some((result) => {
    if (!result.ok) return false;
    if (result.name === "file_view") {
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      return typeof args.path === "string" && artifactPathMatches(args.path, artifact);
    }
    if (result.name !== "bash") return false;
    if (isSemanticFailedCheckResult(result)) return false;
    const command = getToolResultCommand(result);
    return isValidationOfMissingArtifacts(command, [artifact]) || isStrictArtifactCheckCommand(command);
  });
}

function artifactPathMatches(candidate: string, artifact: string): boolean {
  const normalizedCandidate = stripWorkspacePrefix(normalizeArtifactPathForMatch(candidate));
  const normalizedArtifact = stripWorkspacePrefix(normalizeArtifactPathForMatch(artifact));
  return normalizedCandidate === normalizedArtifact || normalizedCandidate.endsWith(`/${normalizedArtifact}`) || normalizedArtifact.endsWith(`/${normalizedCandidate}`);
}

function renderRuntimeBlockingFacts(facts?: RuntimeBlockingFacts): string {
  if (!facts || (!facts.missingArtifacts.length && !facts.failedBuildOrCompile.length && !facts.failedRuntimeOrVerification.length)) {
    return "# Runtime Blocking Facts\nnone";
  }
  return [
    "# Runtime Blocking Facts",
    JSON.stringify({
      missingArtifacts: facts.missingArtifacts,
      failedBuildOrCompile: facts.failedBuildOrCompile,
      failedRuntimeOrVerification: facts.failedRuntimeOrVerification,
      successfulProducerOrVerificationAfterBlocker: facts.successfulProducerOrVerificationAfterBlocker,
      completionRule:
        "If any blockers exist and no later producer/build/test/check succeeded, repair the blocker and prove it with a successful command before stopping.",
    }),
  ].join("\n");
}

function isValidationOfMissingArtifacts(command: string, missingArtifacts: string[]): boolean {
  if (!command.trim()) return false;
  if (isPureMissingArtifactInspectionCommand(command)) return false;
  if (/\bfind\b[\s\S]*\b-name\b|\blocate\b|\bwhich\b|\brealpath\b/i.test(command)) return false;
  if (/\bls\s+(?:-[A-Za-z]+\s+)*(?:\.|\/app|\/tmp|\/workspace|[^;&|]*\/)\b/i.test(command) && !/\b(?:cat|head|tail|test|python|python3|node|jq)\b/i.test(command)) {
    return false;
  }
  if (!/\b(?:cat|jq|python|python3|node|ruby|perl|test|stat|head|tail)\b/i.test(command)) return false;
  return missingArtifacts.some((artifact) => {
    const normalized = normalizeArtifactPathForMatch(artifact);
    if (!normalized) return false;
    const stripped = stripWorkspacePrefix(normalized);
    return command.includes(normalized) || (stripped !== normalized && command.includes(stripped));
  });
}

function isPureMissingArtifactInspectionCommand(command: string): boolean {
  const segments = splitUnquotedShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const normalized = stripQuotedShellText(segment).replace(/\s+/g, " ").trim();
    return (
      /^cd\s+[^;&|]+$/i.test(normalized) ||
      /^(?:ls|find|pwd|file|du|stat|wc|cat|head|tail)\b/i.test(normalized) ||
      /^test\s+-[edfs]\s+[^;&|]+$/i.test(normalized) ||
      /^(?:echo|printf)\b/i.test(normalized)
    );
  });
}


// Phase T3.11: moved to ./file-hints.ts

// Phase T3.11: moved to ./file-hints.ts

function isProducerOrVerificationCommand(command: string): boolean {
  return isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command) || isTaskAcceptanceCommand(command) || isBuildArtifactRuntimeCommand(command);
}

function isRuntimeBlockingResult(result: ToolResult): boolean {
  return isSemanticFailedCheckResult(result) || (!result.ok && isBlockingToolFailure(result));
}

function isBlockingToolFailure(result: ToolResult): boolean {
  const message = result.error?.message ?? "";
  return (
    isSemanticFailedCheckResult(result) ||
    extractMissingArtifactPaths(result).length > 0 ||
    isCompileOrBuildError(message) ||
    isRuntimeOrVerificationFailure(result) ||
    result.error?.code === "missing_build_artifact_runtime_blocked" ||
    result.error?.code === "missing_artifact_validation_blocked"
  );
}

export function isCompileOrBuildError(message: string): boolean {
  return /fatal error:|compilation terminated|undefined reference|no member named|has no member|CMake Error|No rule to make target|build failed|compile|compiler|linker|make: \*\*\*/i.test(
    message,
  );
}

export function isRuntimeOrVerificationFailure(result: ToolResult): boolean {
  if (isSemanticFailedCheckResult(result)) return true;
  const message = result.error?.message ?? "";
  const command = getToolResultCommand(result);
  return (
    result.name === "bash" &&
    (isTestCommand(command) ||
      isVerificationLikeCommand(command) ||
      isBuildArtifactRuntimeCommand(command) ||
      /FileNotFoundError|No such file or directory|cannot access|not found|Traceback|AssertionError|expected|actual|validation|JSON|runtime|test|spec/i.test(message))
  );
}

function extractMissingArtifactPaths(result: ToolResult): string[] {
  const paths: string[] = [];
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  if (!result.ok && result.name === "file_view" && typeof args.path === "string" && /no such file|ENOENT/i.test(result.error?.message ?? "")) {
    paths.push(args.path);
  }
  const message = result.error?.message ?? "";
  const patterns = [
    /No such file or directory: ['"]([^'"]+)['"]/gi,
    /cannot access ['"]([^'"]+)['"]/gi,
    /open ['"]?([^'"\n]+)['"]?: no such file/gi,
    /ENOENT: no such file or directory, open ['"]([^'"]+)['"]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const captured = match[1]?.trim();
      if (captured && isLikelyMissingArtifactPath(captured)) paths.push(captured);
    }
  }
  return uniqueStrings(paths.filter(isLikelyMissingArtifactPath).map((item) => item.replace(/^\.\/+/, "")));
}

function isLikelyMissingArtifactPath(candidate: string): boolean {
  const normalized = candidate.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/tmp/")) return false;
  const basename = path.basename(normalized);
  if (isKnownExecutableName(basename)) return false;
  if (/[/.]/.test(normalized)) return true;
  if (/\.(?:txt|json|jsonl|csv|tsv|xml|html?|ya?ml|toml|ini|cfg|conf|log|out|err|db|sqlite|parquet|feather|pkl|npy|npz|png|jpe?g|gif|webp|pdf|zip|tar|gz|7z)$/i.test(normalized)) {
    return true;
  }
  return /^(?:output|result|results|answer|answers|artifact|artifacts|report|reports|value|values)(?:[-_][A-Za-z0-9]+)*$/i.test(normalized);
}

function isKnownExecutableName(name: string): boolean {
  return /^(?:bash|sh|zsh|fish|env|python|python3|pip|pip3|node|npm|npx|pnpm|yarn|bun|deno|ruby|gem|bundle|go|cargo|rustc|gcc|g\+\+|clang|clang\+\+|make|cmake|ninja|git|docker|docker-compose|curl|wget|tar|unzip|zip|7z|grep|rg|sed|awk|cat|ls|cp|mv|rm|mkdir|touch|chmod|chown|sudo|apt|apt-get|apk|dnf|yum|brew|conda|mamba|pytest|jest|vitest|playwright|java|javac|mvn|gradle)$/i.test(
    name,
  );
}

// Phase T3.11: moved to ./file-hints.ts

// Phase T3.11: moved to ./file-hints.ts

export function isExternalRuntimeLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    /(^|\/)(?:site-packages|dist-packages|\.venv|venv|env|vendor\/bundle|gems|Pods|DerivedData)(\/|$)/i.test(normalized) ||
    /^\/(?:usr|opt|nix|snap|var\/lib|Library|System)\//i.test(normalized) ||
    /^[A-Za-z]:\/(?:Program Files|Windows|Users\/[^/]+\/AppData)\//i.test(normalized)
  );
}

export function isToolchainOrDependencyDiagnosticPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return (
    /^(?:\d+(?:\.\d+)?\/)?bits\//i.test(normalized) ||
    /(?:^|\/)(?:include\/c\+\+|c\+\+\/\d|libstdc\+\+|libc\+\+|boost|eigen3|pybind11|numpy\/core|ruby\/gems|go\/pkg\/mod)(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)(?:bits|asm|sys|linux|machine|objc|Foundation|CoreFoundation)(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:stl_[A-Za-z0-9_]+|type_traits|new_allocator|alloc_traits|shared_ptr_base|exception_ptr)\.h(?:pp)?$/i.test(normalized)
  );
}

function summarizeToolFailure(result: ToolResult): string {
  const command = getToolResultCommand(result);
  const semanticFailure = getSemanticFailureSignal(result);
  const message = (result.error?.message ?? (semanticFailure ? `${semanticFailure.reason}: ${semanticFailure.line}` : "")).replace(/\s+/g, " ").trim();
  const subject = command || String((result.args as { path?: unknown } | undefined)?.path ?? result.name);
  return `${subject.slice(0, 160)} :: ${message.slice(0, 220)}`;
}

// Phase T3.11: moved to ./file-hints.ts
function findLastIndexCompat<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
function getToolResultSummary(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof args.summary === "string" ? args.summary : "";
}
function makeLowInformationToolCallSignature(call: ToolCall): string | undefined {
  if (call.name === "file_view" || call.name === "list_directory") {
    const args = call.args as { path?: unknown; start_line?: unknown; window?: unknown };
    if (typeof args.path !== "string") return undefined;
    return `${call.name}:${JSON.stringify({ path: args.path, start_line: args.start_line, window: args.window })}`;
  }
  if (call.name === "file_find") {
    const args = call.args as { path?: unknown; pattern?: unknown; start_line?: unknown };
    return typeof args.path === "string" && typeof args.pattern === "string"
      ? `${call.name}:${JSON.stringify({ path: args.path, pattern: args.pattern, start_line: args.start_line })}`
      : undefined;
  }
  if (call.name === "grep_search") {
    const args = call.args as { pattern?: unknown; path?: unknown; include?: unknown };
    return typeof args.pattern === "string"
      ? `${call.name}:${JSON.stringify({ pattern: args.pattern, path: args.path, include: args.include })}`
      : undefined;
  }
  if (call.name === "bash") {
    const command = getShellCommandArg(call);
    return isLowInformationShellCommand(command) && !isMutatingShellCommand(command)
      ? `${call.name}:${JSON.stringify({ cmd: normalizeCommandForSignature(command) })}`
      : undefined;
  }
  return undefined;
}

function makeLowInformationToolResultSignature(result: ToolResult): string | undefined {
  if (result.name === "file_view" || result.name === "list_directory") {
    const args = result.args && typeof result.args === "object" ? (result.args as { path?: unknown; start_line?: unknown; window?: unknown }) : {};
    if (typeof args.path !== "string") return undefined;
    return `${result.name}:${JSON.stringify({ path: args.path, start_line: args.start_line, window: args.window })}`;
  }
  if (result.name === "file_find") {
    const args = result.args && typeof result.args === "object" ? (result.args as { path?: unknown; pattern?: unknown; start_line?: unknown }) : {};
    return typeof args.path === "string" && typeof args.pattern === "string"
      ? `${result.name}:${JSON.stringify({ path: args.path, pattern: args.pattern, start_line: args.start_line })}`
      : undefined;
  }
  if (result.name === "grep_search") {
    const args = result.args && typeof result.args === "object" ? (result.args as { pattern?: unknown; path?: unknown; include?: unknown }) : {};
    return typeof args.pattern === "string"
      ? `${result.name}:${JSON.stringify({ pattern: args.pattern, path: args.path, include: args.include })}`
      : undefined;
  }
  if (result.name === "bash") {
    const command = getToolResultCommand(result);
    return isLowInformationShellCommand(command) ? `${result.name}:${JSON.stringify({ cmd: normalizeCommandForSignature(command) })}` : undefined;
  }
  return undefined;
}
function makeToolResultActionSignature(result: ToolResult): string | undefined {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  if (result.name === "bash") {
    const cmd = typeof args.cmd === "string" ? normalizeCommandForSignature(args.cmd) : "";
    return cmd ? `${result.name}:${JSON.stringify({ cmd })}` : undefined;
  }
  if (result.name === "file_edit") {
    return `${result.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "start_line", "end_line", "new_content"].includes(key))))}`;
  }
  if (["edit_file", ].includes(result.name)) {
    return `${result.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "symbolName"].includes(key))))}`;
  }
  return undefined;
}

function extractShellCommandFromUnknownResult(result: ToolResult): string {
  const candidates: unknown[] = [];
  const record = result as unknown as Record<string, unknown>;
  candidates.push(record.cmd, record.command);
  for (const key of ["args", "arguments", "input", "request"]) {
    const value = record[key];
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      candidates.push(nested.cmd, nested.command);
    }
  }
  return candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() ?? "";
}

function toolResultSucceeded(result: ToolResult): boolean {
  if (result.ok === true) return true;
  const record = result as unknown as Record<string, unknown>;
  const output = record.output && typeof record.output === "object" ? (record.output as Record<string, unknown>) : {};
  return output.exitCode === 0 || output.exit_code === 0;
}

function hasNoRemainingPlannedWork(state: GraphState): boolean {
  const progress = planProgress(state.planState);
  if (progress && !progress.isComplete) return false;
  if (state.todoState.items.some((item) => item.status === "pending" || item.status === "in_progress" || item.status === "blocked")) return false;
  const plan = state.executionPlan;
  if (plan?.length) {
    const completed = new Set(state.completedStepIds);
    if (!plan.every((step) => completed.has(step.id))) return false;
  }
  return true;
}

// The reference loop has no iteration budget, no tool cap, no stuck-detection heuristic.
// Reaper's natural-stop path is model-driven.

function extractLastShellCommandFromState(state: GraphState): string {
  const lastShellResult = [...state.toolResults]
    .reverse()
    .find((r) => r.name === "bash");
  const fromResult = lastShellResult ? getToolResultCommand(lastShellResult) || extractShellCommandFromUnknownResult(lastShellResult) : "";
  if (fromResult) return fromResult;
  const lastShellCall = [...(state.split?.executableToolCalls ?? [])]
    .reverse()
    .find((call) => call.name === "bash");
  if (!lastShellCall) return "";
  const args = lastShellCall.args && typeof lastShellCall.args === "object" ? (lastShellCall.args as Record<string, unknown>) : {};
  return (typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : "").trim();
}

function classifyOrchestrationMode(prompt: string, contentPrep: ContentPrepResult): OrchestrationMode {
  const text = prompt.toLowerCase();
  const complexSignals = [
    "full-stack",
    "full stack",
    "from scratch",
    "complete app",
    "complete application",
    "web application",
    "frontend",
    "backend",
    "database",
    "authentication",
    "docker",
    "deployment",
    "real-time",
    "e-commerce",
    "admin dashboard",
    "automated tests",
    "complex",
  ];
  const matchedSignals = complexSignals.filter((signal) => text.includes(signal)).length;
  const patchSignals = [
    "bug fix",
    "bugfix",
    "fix bug",
    "fix failing",
    "fix test",
    "fix tests",
    "patch",
    "regression",
    "compatibility fix",
    "test fix",
    "refactor patch",
    "partial implementation",
  ];
  const existingFiles = contentPrep.preparedContext.fileTree.length;
  if (patchSignals.some((signal) => text.includes(signal)) && existingFiles > 0) {
    return "general_agent_orchestrated";
  }
  if (text.includes("complex task") || matchedSignals >= 2 || prompt.length > 500 || (matchedSignals >= 1 && existingFiles > 80)) {
    return "general_agent_orchestrated";
  }
  return "general_agent_direct";
}

function shouldRunCompaction(input: { prompt: string; toolResults: ToolResult[]; softCap: number }): boolean {
  return calculateContextBudget({ prompt: input.prompt, toolResults: input.toolResults, preparedContextTokens: 0 }).totalTokens >= input.softCap;
}


function calculateContextBudget(input: {
  prompt: string;
  toolResults: ToolResult[];
  preparedContextTokens: number;
}): { promptTokens: number; historyTokens: number; preparedContextTokens: number; totalTokens: number } {
  const promptTokens = estimateTokens(input.prompt);
  const historyTokens = estimateTokens(JSON.stringify(input.toolResults.map((result) => renderToolResultForModel(result))));
  const totalTokens = promptTokens + historyTokens + input.preparedContextTokens;
  return {
    promptTokens,
    historyTokens,
    preparedContextTokens: input.preparedContextTokens,
    totalTokens,
  };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

async function logContextBudget(input: {
  workspaceRoot: string;
  runId: string;
  sessionId: string;
  traceId: string;
  budget: ReturnType<typeof calculateContextBudget>;
  softCap: number;
  compacted: boolean;
}): Promise<void> {
  await logLangfuseEvent({
    workspaceRoot: input.workspaceRoot,
    name: "reaper.context.budget",
    type: "event",
    input: input.budget,
    output: {
      softCap: input.softCap,
      remainingTokens: input.softCap - input.budget.totalTokens,
      compacted: input.compacted,
    },
    metadata: {
      softCap: input.softCap,
      compacted: input.compacted,
    },
    trace: {
      runId: input.runId,
      sessionId: input.sessionId,
      traceId: input.traceId,
      tags: ["reaper", "context", input.compacted ? "compaction" : "no-compaction"],
    },
  });
}



function normalizeCommandForSignature(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function isLowInformationToolResult(result: ToolResult): boolean {
  if (result.name === "bash") return isLowInformationShellCommand(getToolResultCommand(result));
  if (result.name !== "file_view"&& result.name !== "list_directory" && result.name !== "grep_search") return false;
  const args = result.args as { path?: unknown; pattern?: unknown };
  return result.name === "grep_search" ? typeof args.pattern === "string" : typeof args.path === "string";
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}


export function normalizePlannerStepTypeLabel(type: PlannerStepType, text: string): PlannerStepType {
  return normalizePlanStepType(type, text);
}

function hasSuccessfulLocalVerification(results: ToolResult[]): boolean {
  return results.some((result) => {
    if (!result.ok || result.name !== "bash") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    return isSuccessfulStrictVerificationResult(result, cmd, output);
  });
}

function hasRecentSuccessfulLocalVerification(results: ToolResult[]): boolean {
  return hasSuccessfulLocalVerification(results.slice(-12));
}

function hasSuccessfulAcceptanceEvidence(results: ToolResult[]): boolean {
  return results.some((result) => {
    if (!result.ok || result.name !== "bash") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    return isSuccessfulVerificationResult(result, cmd, output);
  });
}
/**
 * Blocker codes that mean the run did not do what was asked.
 *
 * The engine raises blockers for two different reasons: some report a failure,
 * and some are advisory notes about a condition it already worked around.
 * Only the first kind may change how a turn reads — calling an advisory note a
 * failure would be its own bug — and that decision is made in three places:
 * whether to publish `turn.completed`, whether to publish `task_completed`, and
 * what status the turn closes with.
 *
 * Those three were separate `||` chains over the same two codes until a third
 * code was added to the engine and none of the three, so a run that failed with
 * a plain model-call error still announced itself as finished everywhere.
 * Membership lives here now, and the three sites ask.
 */
const STOPPED_SHORT_BLOCKER_CODES = new Set<string>([
  // The model returned an empty response on every retry.
  "empty_model_response",
  // The provider was reachable-failed (429/5xx/timeout) and retries were spent.
  "main_agent_transport_error",
  // The model call threw something that is not a recognised transport error.
  "model_call_failed",
]);

export function isStoppedShortBlocker(blocker: { code: string }): boolean {
  return STOPPED_SHORT_BLOCKER_CODES.has(blocker.code);
}

/**
 * The HTTP status a provider error is about, whether it is a property or only
 * written into the message.
 *
 * Most of the provider clients construct a plain `Error` and bake the status
 * into the text — `Anthropic stream failed: HTTP 502 - {...}` — so reading
 * `.status` alone finds nothing and every one of those failures fell through to
 * the generic handler. The match is deliberately on `HTTP <code>` rather than
 * any three-digit number: a message reading "input is 4012 tokens" must not be
 * mistaken for a 401.
 */
function httpStatusOf(error: unknown, message: string): number | undefined {
  if (typeof error === "object" && error !== null) {
    const candidate = (error as { status?: unknown }).status;
    if (typeof candidate === "number") return candidate;
  }
  const match = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) return undefined;
  const code = Number.parseInt(match[1]!, 10);
  return code >= 400 ? code : undefined;
}

export function classifyMainAgentTransportError(error: unknown):
  | { code: "main_agent_transport_error"; message: string; details: string[] }
  | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = httpStatusOf(error, message);
  const isTransport =
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529 ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("provider_unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed");
  if (!isTransport) return undefined;
  const rateLimited =
    status === 429 || lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("too many requests");
  const retryClass = rateLimited ? "rate_limit" : "transport";
  return {
    code: "main_agent_transport_error",
    /*
     * Written to be read by a person, because `message` is not only fed back
     * into the loop — it is what the failed turn shows the user. It used to
     * explain itself to the model ("this is infrastructure/provider
     * backpressure, not a malformed agent response; retry the model call
     * without consuming completion-gate attempts"), which is the right advice
     * for the run and useless on screen: it never says which provider failed or
     * why. The model-facing instruction lives in the nudge built by the
     * transport-retry helper, where the model will actually read it.
     */
    message:
      `The model provider failed with a ${status ?? "network"} ${rateLimited ? "rate limit" : "transport"} error, `
      + `and the run was stopped after retrying.\n${message}\n`
      + "Send the message again, or switch models in the composer.",
    details: [
      `status=${status ?? "unknown"}`,
      `class=${retryClass}`,
      "Do not treat provider 429/5xx/timeouts as empty tool batches or schema failures.",
    ],
  };
}

/**
 * Detect a Provider-Token-Limit (PTL) error: the request body was too large
 * for the provider's context window. Distinct from a transport error: the
 * connection succeeded but the server rejected the request as too large.
 *
 * Used by `streamMainAgentResponseWithTransportRetry` to decide whether
 * to invoke the PTL-recovery hook (shrink the conversation) before
 * giving up.
 */
export function isProviderTokenLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : undefined;
  // Common PTL signals: HTTP 413, HTTP 400 with "too many tokens" /
  // "context length" / "max tokens" / "context_length" in the body,
  // or MiniMax's token-overflow code 2014. Error 2013 ("chat content
  // is empty") is input-shape validation and must not trigger pruning.
  if (status === 413) return true;
  if (status === 400 && (
    lower.includes("context length") ||
    lower.includes("context_length") ||
    lower.includes("max tokens") ||
    lower.includes("max_tokens") ||
    lower.includes("tokens exceed") ||
    lower.includes("too many tokens") ||
    lower.includes("too long") ||
    lower.includes("2014")
  )) return true;
  return false;
}

/**
 * Replace live model messages without destroying an in-place recovery
 * result. Some context hooks intentionally mutate and return the caller's
 * array; clearing that same array before spreading it erases all context.
 */
export function replaceConversationMessages<T>(target: T[], replacement: T[]): void {
  if (target === replacement) return;
  target.length = 0;
  target.push(...replacement);
}

/**
 * Wraps a main-agent model call with a small transport-aware retry.
 *
 * - On transient provider failures (rate limit / 5xx / timeout / network),
 *   retry up to N times with exponential backoff. Backoff: 0s, 1s, 3s, 9s.
 *   This is *not* a runtime stop and not a model decision — the provider
 *   is allowed to hiccup.
 * - If the request still fails after the retry budget, return a
 *   structured assistant turn whose content is a transparent description
 *   of the failure, addressed to the model. The model can decide
 *   whether to stop, retry, or take some other action. The runtime
 *   does not mark the run failed; the model owns the stop decision.
 *
 * Non-transport errors (schema, parse) are not retried here; they
 * propagate to the live loop's outer catch.
 */
/**
 * The backoff ladder, with the waits removable.
 *
 * A test that exercises the exhausted-retry path has to let it exhaust, and the
 * ladder sleeps thirteen seconds doing it — which is most of such a test's
 * runtime, and the reason `main-agent-transport-retry.test.ts` alone takes
 * thirteen seconds every run. `REAPER_TRANSPORT_RETRY_BACKOFF_MS=0` removes the
 * waiting and nothing else: the number of attempts, the classification, the
 * blocker and the transcript are all untouched, so a test that passes with it
 * set has still exercised the real path.
 *
 * This is a test seam, not a product option. Nothing in the app sets it, and
 * unset behaviour is unchanged.
 */
function transportBackoffsMs(): number[] {
  if (process.env.REAPER_TRANSPORT_RETRY_BACKOFF_MS !== "0") return [0, 1_000, 3_000, 9_000];
  return [0, 0, 0, 0];
}

export async function streamMainAgentResponseWithTransportRetry(
  modelGateway: ModelGateway,
  request: GenerateRequest,
  trajectoryLogger: TrajectoryLogger,
  ctxHooks?: { onProviderTokenLimitError?: (p: { messages: unknown[]; softCap: number; runId?: string }) => Promise<{ messages: unknown[]; savedChars: number }> },
  softCap?: number,
  runId?: string,
  streamCallbacks?: Parameters<typeof streamMainAgentResponse>[2],
): Promise<Awaited<ReturnType<typeof streamMainAgentResponse>>> {
  const backoffsMs = transportBackoffsMs();
  let lastError: unknown;
  for (const delayMs of backoffsMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await streamMainAgentResponse(modelGateway, request, streamCallbacks);
    } catch (error) {
      lastError = error;
      // Detect PTL (provider token limit exceeded) and attempt recovery:
      // drop the oldest tool result, then retry. The "max tokens" 400
      // is a class of transport error that IS recoverable by shrinking
      // the conversation, distinct from a network 5xx.
      const isPtl = isProviderTokenLimitError(error);
      if (isPtl && ctxHooks?.onProviderTokenLimitError) {
        try {
          const softCapValue = softCap ?? 270_000;
          const result = await ctxHooks.onProviderTokenLimitError({
            messages: request.messages as unknown[],
            softCap: softCapValue,
            ...(runId ? { runId } : {}),
          });
          if (Array.isArray(result?.messages) && result.messages.length > 0) {
            request = { ...request, messages: result.messages as any };
            try {
              await trajectoryLogger.write({
                event_id: randomUUID(),
                run_id: runId ?? (request as { runId?: string }).runId ?? "unknown",
                session_id: (request as { sessionId?: string }).sessionId ?? "unknown",
                trace_id: (request as { traceId?: string }).traceId ?? runId ?? (request as { runId?: string }).runId ?? "unknown",
                timestamp: new Date().toISOString(),
                log_schema_version: 1,
                kind: "ptl_recovery",
                level: "info",
                saved_chars: result.savedChars,
                remaining_messages: result.messages.length,
              } as any);
            } catch { /* swallow */ }
            continue; // retry with the shrunken messages
          }
        } catch { /* swallow PTL recovery errors */ }
      }
      if (!classifyMainAgentTransportError(error)) {
        throw error;
      }
      continue;
    }
  }
  const transportInfo = classifyMainAgentTransportError(lastError) ?? {
    code: "main_agent_transport_error" as const,
    message: lastError instanceof Error ? lastError.message : String(lastError),
    details: [],
  };
  /*
   * Two audiences, two messages, and until now they were one string.
   *
   * Everything here used to be folded into a single note and handed back as the
   * assistant's content. That content is fed into the conversation for the model
   * to read, so the note has to be addressed to the model — and it was, which
   * is precisely why it read so badly once the failure started reaching the
   * screen: a user got a paragraph of runtime instructions ("the runtime retried
   * with backoff… you decide what to do next") instead of being told the
   * provider was down. The same sentence then appeared twice, because the alert
   * repeated it.
   *
   * So the model keeps its instructions and the user gets the sentence from
   * `transportInfo.message`, which names the provider, the status and the cause.
   */
  const modelNote =
    `[Reaper note] Your last model call failed with a transport error: ${transportInfo.message}\n` +
    `The runtime retried ${backoffsMs.length - 1} times with backoff. The provider is still unavailable.\n` +
    `You decide what to do next: stop and write a final summary, keep working with the results you already have, or take some other action.`;
  try {
    await trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: (request as { runId?: string }).runId ?? "unknown",
      session_id: (request as { sessionId?: string }).sessionId ?? "unknown",
      trace_id: (request as { traceId?: string }).traceId ?? (request as { runId?: string }).runId ?? "unknown",
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "assistant_message",
      level: "info",
      content: modelNote,
    });
  } catch {
    // Trajectory is best-effort; never let it block the live loop.
  }
  return {
    content: modelNote,
    finishReason: "stop" as const,
    toolCalls: [],
    role: "assistant" as const,
    provider: "reaper-fallback",
    model: "transport-fallback",
    raw: { transportFallback: true, transportBlockerMessage: transportInfo.message },
  } as unknown as Awaited<ReturnType<typeof streamMainAgentResponse>>;
}

export function countConsecutiveModelTransportBlockers(blockers: Array<{ source: string; code: string }>): number {
  let count = 0;
  for (let index = blockers.length - 1; index >= 0; index -= 1) {
    const blocker = blockers[index];
    if (blocker?.source === "model" && blocker.code === "main_agent_transport_error") {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

export function mainAgentTransportRetryLimit(): number {
  const parsed = Number(getEngineTunables().mainAgentTransportRetryLimit ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

export function selectRecentStrictVerificationEvidence(results: ToolResult[]): { command: string } | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result || !result.ok || result.name !== "bash") continue;
    const command = getToolResultCommand(result);
    if (!isSuccessfulStrictVerificationResult(result, command)) continue;
    return { command };
  }
  return undefined;
}


async function createMutationCheckpointResult(input: {
  workspaceRoot: string;
  runId: string;
  toolCalls: ToolCall[];
}): Promise<ToolResult> {
  const startedAt = Date.now();
  const toolCallId = `auto-checkpoint-${randomUUID()}`;
  const args = {
    reason: "Automatic checkpoint before mutating tool batch",
    toolCallIds: input.toolCalls.map((call) => call.id),
  };
  try {
    const checkpoint = await createCheckpoint({
      workspaceRoot: input.workspaceRoot,
      reason: args.reason,
      toolCallIds: args.toolCallIds,
    });
    return {
      toolCallId,
      name: "create_checkpoint",
      ok: true,
      durationMs: Date.now() - startedAt,
      args,
      output: checkpoint,
    };
  } catch (error) {
    return {
      toolCallId,
      name: "create_checkpoint",
      ok: false,
      durationMs: Date.now() - startedAt,
      args,
      error: {
        code: "checkpoint_create_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function createPostMutationGitResults(workspaceRoot: string, runId: string): Promise<ToolResult[]> {
  const statusStartedAt = Date.now();
  const statusCallId = `auto-git-status-${randomUUID()}`;
  let statusResult: ToolResult;
  try {
    const status = await getGitStatusState(workspaceRoot);
    statusResult = {
      toolCallId: statusCallId,
      name: "git_status",
      ok: true,
      durationMs: Date.now() - statusStartedAt,
      args: {},
      output: status,
    };
  } catch (error) {
    statusResult = {
      toolCallId: statusCallId,
      name: "git_status",
      ok: false,
      durationMs: Date.now() - statusStartedAt,
      args: {},
      error: {
        code: "git_status_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const diffStartedAt = Date.now();
  const diffCallId = `auto-git-diff-${randomUUID()}`;
  let diffResult: ToolResult;
  try {
    const diff = await getGitDiffState(workspaceRoot);
    diffResult = {
      toolCallId: diffCallId,
      name: "git_diff",
      ok: true,
      durationMs: Date.now() - diffStartedAt,
      args: {},
      output: {
        ...diff,
        summary: summarizeGitDiffState(diff),
      },
    };
  } catch (error) {
    diffResult = {
      toolCallId: diffCallId,
      name: "git_diff",
      ok: false,
      durationMs: Date.now() - diffStartedAt,
      args: {},
      error: {
        code: "git_diff_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return [statusResult, diffResult];
}
export function isTaskAcceptanceCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /\bpython3?\s+(?:\.\/)?[A-Za-z0-9_./-]+\.py(?:\s|$)/i.test(normalized) ||
    /\b(?:cat|head|tail|wc|grep|awk|sed|jq)\b.*\b(?:output|result|summary|report|answer|submission|solution|expected|actual)[A-Za-z0-9_.-]*\b/i.test(normalized) ||
    /\btest\s+(?:-[fes]|!?\s*"\$\(cat\b)/i.test(normalized)
  );
}

function isSuccessfulVerificationResult(result: ToolResult, cmd: string, output?: Record<string, unknown>): boolean {
  const resolvedOutput = output ?? (result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {});
  const exitCode = typeof resolvedOutput.exitCode === "number" ? resolvedOutput.exitCode : undefined;
  if (exitCode !== 0) return false;
  if (isSemanticFailedCheckResult(result)) return false;
  return isVerificationLikeCommand(cmd) || isTaskAcceptanceCommand(cmd) || isBuildCommand(cmd) || isTestCommand(cmd);
}

function isSuccessfulStrictVerificationResult(result: ToolResult, cmd: string, output?: Record<string, unknown>): boolean {
  const resolvedOutput = output ?? (result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {});
  const exitCode = typeof resolvedOutput.exitCode === "number" ? resolvedOutput.exitCode : undefined;
  if (exitCode !== 0) return false;
  if (isSemanticFailedCheckResult(result)) return false;
  const semantic = classifyShellCommandSemantics(cmd);
  if (semantic.kind === "weak_check" || semantic.kind === "inspect" || semantic.kind === "producer") return false;
  return semantic.kind === "strict_verifier" || isVerificationLikeCommand(cmd) || isBuildCommand(cmd) || isTestCommand(cmd) || isStrictArtifactCheckCommand(cmd);
}

export function isStrictArtifactCheckCommand(command: string): boolean {
  const semantic = classifyShellCommandSemantics(command);
  if (semantic.kind === "weak_check" || semantic.kind === "inspect" || semantic.kind === "producer") return false;
  const normalized = normalizeVerificationCommand(command);
  return (
    /(?:^|[;&|]\s*)(?:test\s+|\[\s+|diff\b|cmp\b|sha1sum\b|sha256sum\b|md5sum\b|grep\s+-q\b|jq\s+-e\b)/i.test(normalized) ||
    (/\bpython3?\s+-c\b/i.test(normalized) && hasInlineAssertionOrFailureExit(normalized))
  );
}

function hasSuccessfulCurrentBatchVerification(toolCalls: ToolCall[], results: ToolResult[]): boolean {
  if (toolCalls.length === 0) return false;
  const ids = new Set(toolCalls.map((call) => call.id));
  return hasSuccessfulLocalVerification(results.filter((result) => ids.has(result.toolCallId)));
}

function hasSuccessfulCurrentBatchAcceptanceEvidence(toolCalls: ToolCall[], results: ToolResult[]): boolean {
  if (toolCalls.length === 0) return false;
  const ids = new Set(toolCalls.map((call) => call.id));
  return hasSuccessfulAcceptanceEvidence(results.filter((result) => ids.has(result.toolCallId)));
}

function isVerificationDrivenPlanStep(step?: ExecutionPlanStep): boolean {
  if (!step) return false;
  const text = `${step.id}\n${step.title}\n${step.instructions}\n${step.testGuidance ?? ""}\n${(step.successCriteria ?? []).join("\n")}`.toLowerCase();
  if (["command", "test", "verify", "finalize"].includes(step.type ?? "")) {
    return /\b(?:build|compile|test|verify|validate|check|run|convert|generate|produce|output|artifact)\b/.test(text);
  }
  return /\b(?:fix|repair|port|compatib|migrat|implement|create|write|build|compile|test|verify|validate|check|run|convert|generate|produce|output|artifact)\b/.test(text);
}

function hasFailedCurrentBatch(toolCalls: ToolCall[], results: ToolResult[]): boolean {
  if (toolCalls.length === 0) return false;
  const ids = new Set(toolCalls.map((call) => call.id));
  return results.some((result) => ids.has(result.toolCallId) && (!result.ok || isSemanticFailedCheckResult(result)));
}

function shouldAdvanceBuildConfigStepToLaterImplementation(input: {
  step: ExecutionPlanStep;
  plan: ExecutionPlanStep[] | undefined;
  currentStepIndex: number;
  toolCalls: ToolCall[];
  results: ToolResult[];
}): boolean {
  const stepText = [
    input.step.id,
    input.step.title,
    input.step.instructions,
    input.step.suggestedImplementation ?? "",
    ...(input.step.successCriteria ?? []),
  ]
    .join("\n")
    .toLowerCase();
  if (!/\b(?:cmake|makefile|build config|build configuration|build target|project file)\b/.test(stepText)) return false;
  if (!/\b(?:create|add|write|update|configure)\b/.test(stepText)) return false;
  const laterText = (input.plan ?? [])
    .slice(input.currentStepIndex + 1)
    .map((step) => `${step.id}\n${step.title}\n${step.instructions}\n${step.suggestedImplementation ?? ""}`)
    .join("\n")
    .toLowerCase();
  if (!/\b(?:implement|write|fix|build|test|verify)\b[\s\S]{0,120}\b(?:source|converter|program|code|implementation|executable|binary)\b/.test(laterText)) {
    return false;
  }
  const ids = new Set(input.toolCalls.map((call) => call.id));
  const currentResults = input.results.filter((result) => ids.has(result.toolCallId));
  const wroteBuildConfig = currentResults.some((result) => {
    if (!result.ok || !["write_file", "file_edit", "edit_file"].includes(result.name)) return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const target = typeof args.path === "string" ? args.path.replace(/\\/g, "/") : "";
    return /(?:^|\/)(?:CMakeLists\.txt|Makefile|GNUMakefile|meson\.build|BUILD(?:\.bazel)?|WORKSPACE|configure\.ac|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(
      target,
    );
  });
  if (!wroteBuildConfig) return false;
  return currentResults.some((result) => {
    if (result.ok || result.name !== "bash") return false;
    const command = getToolResultCommand(result);
    if (!isBuildCommand(command) && !isVerificationLikeCommand(command)) return false;
    const message = result.error?.message ?? "";
    if (/CMake Error|configure: error|No rule to make target|could not find package|cannot find -l|undefined reference/i.test(message)) return false;
    return /(?:^|\s|["'`])[\w./-]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|swift|rs|go|java|kt|kts|scala|py|js|jsx|ts|tsx|rb|php)(?::\d+)?/i.test(
      message,
    );
  });
}

function isTolerableInspectionBatchFailure(step: ExecutionPlanStep, toolCalls: ToolCall[], results: ToolResult[]): boolean {
  if (toolCalls.length === 0) return false;
  const ids = new Set(toolCalls.map((call) => call.id));
  const currentResults = results.filter((result) => result.toolCallId && ids.has(result.toolCallId));
  const failed = currentResults.filter((result) => !result.ok);
  if (failed.length === 0) return false;
  const isInspectionLikeStep = step.type === "inspect" || step.type === "review";
  const failedOnlyBecauseOptionalInspectionUtilityMissing = failed.every((result) =>
    isOptionalInspectionUtilityMissingResult(result, isInspectionLikeStep),
  );
  if (!failedOnlyBecauseOptionalInspectionUtilityMissing) return false;
  if (failed.length !== currentResults.length) {
    return isInspectionLikeStep && currentResults.some((result) => result.ok && hasInformativeToolResultOutput(result));
  }
  return failed.every((result) => {
    if (result.name !== "bash") return false;
    const command = getToolResultCommand(result);
    if ((step.type !== "inspect" && step.type !== "review") && (isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command))) {
      return false;
    }
    const message = result.error?.message ?? "";
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    const stdout = typeof output.stdout === "string" ? output.stdout.trim() : "";
    return stdout.length > 0 && /(?:command not found|No such file or directory).*?\b(?:file|tree|which|realpath|readlink|du|stat)\b|\b(?:file|tree|which|realpath|readlink|du|stat): command not found/i.test(message);
  });
}

function isOptionalInspectionUtilityMissingResult(result: ToolResult, isInspectionLikeStep: boolean): boolean {
  if (!isInspectionLikeStep || result.name !== "bash") return false;
  const command = getToolResultCommand(result);
  if (isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command)) return false;
  const message = result.error?.message ?? "";
  return /(?:command not found|No such file or directory).*?\b(?:file|tree|which|realpath|readlink|du|stat|xxd|hexdump|strings)\b|\b(?:file|tree|which|realpath|readlink|du|stat|xxd|hexdump|strings): command not found/i.test(message);
}

export function hasInformativeToolResultOutput(result: ToolResult): boolean {
  if (!result.ok) return false;
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const stdout = typeof output.stdout === "string" ? output.stdout.trim() : "";
  const stderr = typeof output.stderr === "string" ? output.stderr.trim() : "";
  if (stdout || stderr) return true;
  return ["file_view", "file_find", "list_directory", "grep_search", "skim_file", "inspect_environment"].includes(result.name);
}

function hasLaterPlanStep(plan: ExecutionPlanStep[] | undefined, currentStepIndex: number): boolean {
  return Boolean(plan && currentStepIndex + 1 < plan.length);
}

function isOptionalExploratoryPlanStep(step?: ExecutionPlanStep): boolean {
  if (!step) return false;
  const text = [
    step.id,
    step.title,
    step.instructions,
    step.suggestedImplementation ?? "",
    step.testGuidance ?? "",
    ...(step.successCriteria ?? []),
  ]
    .join("\n")
    .toLowerCase();
  if (/\b(?:official|required|acceptance|exit criteria|deliverable|must pass|must run|final validation|user requested|required output)\b/.test(text)) {
    return false;
  }
  if (/\b(?:create|generate|produce|write|convert|implement|output|artifact|deliverable)\b/.test(text)) {
    return false;
  }
  return (
    /\b(?:optional|exploratory|diagnostic|observe|clues?|understand|learn|inspect behavior|demo|sample|example)\b/.test(text) ||
    /\bif (?:a |an |the )?(?:test|example|sample|demo|executable|target|binary).*(?:exists|was built|is built|available)\b/.test(text)
  );
}
function hasPlaceholderShellOutput(result: ToolResult): boolean {
  if (result.name !== "bash" || !result.ok) return false;
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      if (/^(?:ℹ\s*)?#?\s*todo\s+(?:\d+|none)\b/i.test(line) || /^#?\s*(?:0\s+)?todos?\b/i.test(line)) return false;
      return /\b(?:stub(?:bed)?|todo|placeholder|not implemented|implementation coming)\b/i.test(line);
    });
}

export function isLowInformationShellCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|init)\b|\bnpx\s+create-|\bpip\s+install\b|\bpoetry\s+install\b/.test(normalized) ||
    /^(?:cd\s+[^&;|]+\s*&&\s*)?(?:mkdir|touch|cp|mv|rm|cat|echo)\b/.test(normalized.trim())
  );
}

function isMutatingShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  if (/(?:^|[;&|]\s*)(?:cd\s+[^;&|]+\s*&&\s*)?(?:mkdir|touch|cp|mv|rm)\b/.test(normalized)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|init)\b|\bnpx\s+create-|\bpip\s+install\b|\bpoetry\s+install\b/.test(normalized)) return true;
  if (/\bsed\b[^;&|]*\s-i\b|\bperl\b[^;&|]*\s-[^\s]*i\b/i.test(command)) return true;
  if (hasSourceMutationShellFragment(command)) return true;
  if (/(?:^|[^<>])>{1,2}[^&]|\btee\s+/.test(command)) return true;
  return false;
}

/**
 * Build the cockpit input bundle from the current ContentPrepResult
 * plus the exact current user request and bounded runtime facts.
 *
 * The cockpit is the single harness-authored user message the engine
 * inserts after prior named-session history. It is byte-stable across
 * the run for the same inputs; the model sees it as data (rendered
 * via `renderContextCockpit`), not as system authority.
 */
export function buildCockpitInput(input: {
  contentPrep: ContentPrepResult;
  runtimeFacts: {
    activeWorkspaceRoot: string;
    latestVerificationFailure?: string;
  };
}): CockpitInput {
  const { contentPrep } = input;
  /*
   * Everything here is already trusted, and this no longer re-checks it.
   *
   * `content-prep` merges the packaged skills with the workspace walk and
   * applies the project-trust gate to the workspace half only — the gate is
   * about repository-controlled text, and a skill compiled into the binary is
   * not that. Re-applying `resourceTrust.trusted` here would filter the merged
   * list as a whole and drop the packaged skills in exactly the workspace state
   * they were written for: a fresh, untrusted one.
   *
   * What is left to exclude is explicit silencing, which is a different flag
   * from trust and reaches here through the manifest's
   * `disable-model-invocation`.
   */
  const trustedSkills = contentPrep.skills.filter((skill) => skill.disableModelInvocation !== true);
  return {
    preparedContext: contentPrep.preparedContext,
    contextFiles: contentPrep.contextFiles,
    skills: contentPrep.skills,
    trustedSkills,
    invokedSkills: contentPrep.invokedSkills,
    resourceTrust: contentPrep.resourceTrust,
    environmentFingerprint: contentPrep.environmentFingerprint,
    mentions: contentPrep.mentions,
    runtimeFacts: input.runtimeFacts,
    contentFingerprint: contentPrep.preparedContext.fingerprint,
  };
}

/**
 * Insert (or replace in place) exactly one harness-authored cockpit
 * user message after prior named-session history and before any
 * new turn. Guarantees:
 *   - exactly one cockpit marker pair exists in the conversation,
 *   - the cockpit appears AFTER all prior user/assistant/tool
 *     messages that came before this run's turn,
 *   - the current task intent is preserved verbatim at the recency
 *     edge (last section of the cockpit).
 */
/**
 * @deprecated The runtime no longer inserts a curated cockpit
 * context bundle. The Pi-parity refactor removed this so the model
 * explores the workspace itself with its own tool calls. This
 * function is preserved as a guarded no-op for any external code
 * that imports its symbol. Set `REAPER_LEGACY_COCKPIT=1` to opt back
 * into the previous behavior.
 */
export function insertCockpitIntoConversation(input: {
  messages: GenerateRequest["messages"];
  contentPrep: ContentPrepResult;
  currentUserRequest: string;
  activeWorkspaceRoot: string;
  latestVerificationFailure?: string;
}): void {
  if (process.env.REAPER_LEGACY_COCKPIT !== "1") {
    // Drop any stale cockpit text from resumed snapshots before
    // appending the raw prompt — keeps the conversation clean
    // across named-session boundaries.
    const cleaned = stripCockpitFromMessages(input.messages as GenerateRequest["messages"]);
    const withoutCurrentRequest = cleaned.filter(
      (message) => !(message.role === "user" && message.name === CURRENT_REQUEST_MESSAGE_NAME),
    );
    const exists = withoutCurrentRequest.some(
      (message) => message.role === "user" && message.name === CURRENT_REQUEST_MESSAGE_NAME,
    );
    if (!exists && input.currentUserRequest) {
      withoutCurrentRequest.push({
        role: "user",
        name: CURRENT_REQUEST_MESSAGE_NAME,
        content: input.currentUserRequest,
      });
    }
    input.messages.length = 0;
    input.messages.push(...withoutCurrentRequest);
    return;
  }
  const cockpit = renderContextCockpit(buildCockpitInput({
    contentPrep: input.contentPrep,
    runtimeFacts: {
      activeWorkspaceRoot: input.activeWorkspaceRoot,
      ...(input.latestVerificationFailure ? { latestVerificationFailure: input.latestVerificationFailure } : {}),
    },
  }));
  // Strip any prior cockpit to keep exactly one.
  const existingCockpitIndex = input.messages.findIndex(
    (message) => message.role === "user" && typeof message.content === "string" && containsCockpitMarker(message.content),
  );
  const existingRequestIndex = input.messages.findIndex(
    (message) => message.role === "user" && message.name === CURRENT_REQUEST_MESSAGE_NAME,
  );
  const insertionIndex = existingCockpitIndex >= 0
    ? existingCockpitIndex
    : existingRequestIndex >= 0
      ? existingRequestIndex
      : input.messages.length;
  const stripped = stripCockpitFromMessages(input.messages as GenerateRequest["messages"])
    .filter((message) => !(message.role === "user" && message.name === CURRENT_REQUEST_MESSAGE_NAME));
  stripped.splice(
    Math.min(insertionIndex, stripped.length),
    0,
    { role: "user", content: cockpit },
    { role: "user", name: CURRENT_REQUEST_MESSAGE_NAME, content: input.currentUserRequest },
  );
  // Replace in-place to preserve the live conversation array identity.
  input.messages.length = 0;
  input.messages.push(...stripped);
}

function extractShellCmd(result: ToolResult): string {
  const args = (result.args ?? {}) as { cmd?: unknown; command?: unknown };
  return typeof args.cmd === "string"
    ? args.cmd
    : typeof args.command === "string"
      ? args.command
      : "";
}

/**
 * Defensive extractor for `request.payload.prompt`. Returns the
 * raw user-request bytes (a string) verbatim. We never regex-extract
 * or strip "User prompt:" / "[exec environment]" segments — those
 * substrings may legitimately appear inside a user's request.
 * If a legacy transport preamble truly needs stripping, gate it on
 * explicit envelope metadata.
 */
function rawUserPromptValueSafe(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Cap feedback for context budget. Keep last N entries; cap each entry to
 * maxChars. Without this, accumulated feedback from multiple replan cycles
 * can reach 10KB+ and dominate the prompt (as observed in run 06-23T18:56:50).
 */
function capFeedbackForContext(feedback: string[], maxEntries = 3, maxChars = 800): string[] {
  if (feedback.length === 0) return feedback;
  const tail = feedback.slice(-maxEntries);
  return tail.map((entry) => {
    if (entry.length <= maxChars) return entry;
    const notice = `\n...[${entry.length - maxChars} chars truncated for context budget]...`;
    const head = Math.floor((maxChars - notice.length) * 0.6);
    const tailChars = maxChars - notice.length - head;
    return `${entry.slice(0, head)}${notice}${entry.slice(-tailChars)}`;
  });
}

/**
 * Aggressively context-budget the recent tool results for long-horizon runs.
 * Returns a list of {summary, ...metadata} instead of full outputs. The model
 * can re-run the tool when it actually needs the content. This cuts the
 * "Recent Tool Results" section from ~26KB to ~3KB on a long task.
 */
function renderRecentToolResultsForPromptCompact(results: ToolResult[], feedback: string[], count: number): Record<string, unknown>[] {
  const compact =
    hasRecentStructuredResponseFallbackFeedback(feedback) ||
    hasRecentIncompleteGeneratedArtifact(results) ||
    hasRecentLargeToolOutput(results) ||
    results.length > 12;
  const selected = selectContextEfficientRecentResults(results, count, compact);
  return selected.map((result) => renderRecentToolResultSummary(result));
}

/**
 * Compact renderer for a single tool result. Preserves the path/cmd/exit/error
 * (what the model needs to decide the next action) but drops the full output
 * content. write_file/bash/file_view results all collapse to a
 * one-line summary.
 */
function renderRecentToolResultSummary(result: ToolResult): Record<string, unknown> {
  const base: Record<string, unknown> = {
    toolCallId: result.toolCallId,
    name: result.name,
    ok: result.ok,
    durationMs: result.durationMs,
  };
  const output = (result.output && typeof result.output === "object" ? result.output : {}) as Record<string, unknown>;
  const args = (result.args && typeof result.args === "object" ? result.args : {}) as Record<string, unknown>;

  // file_view: just the path + line range + truncated marker. The model can re-read.
  if (result.name === "file_view") {
    const path = typeof output.path === "string" ? output.path : typeof args.path === "string" ? args.path : "";
    return {
      ...base,
      ...(path ? { path } : {}),
      ...(typeof output.startLine === "number" ? { startLine: output.startLine } : {}),
      ...(typeof output.endLine === "number" ? { endLine: output.endLine } : {}),
      ...(typeof output.totalLines === "number" ? { totalLines: output.totalLines } : {}),
      ...(output.truncated ? { truncated: true } : {}),
      output: `file_view ${path} (lines ${output.startLine ?? "?"}-${output.endLine ?? "?"} of ${output.totalLines ?? "?"}) — content omitted to save context; re-read with grep_search or file_view when needed.`,
    };
  }

  // write_file / file_edit / edit_file: just the path + ok/error. Successful writes don't need to be re-shown.
  if (result.name === "write_file" || result.name === "file_edit" || result.name === "edit_file") {

    const path = typeof args.path === "string" ? args.path : "";
    if (result.ok) {
      return {
        ...base,
        ...(path ? { path } : {}),
        output: `wrote ${path} (${(typeof args.content === "string" ? args.content.length : 0)} chars)`,
      };
    }
    return {
      ...base,
      ...(path ? { path } : {}),
      output: `write failed for ${path}`,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  // bash: cmd + exit code + truncated output. The model needs the exit code to decide next action.
  if (result.name === "bash") {
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    const stdout = typeof output.stdout === "string" ? output.stdout : "";
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    return {
      ...base,
      cmd: cmd.slice(0, 200),
      exitCode: output.exitCode ?? null,
      ...(typeof output.wouldBlock === "boolean" ? { wouldBlock: output.wouldBlock } : {}),
      stdoutPreview: stdout.length > 400 ? `${stdout.slice(0, 200)}\n...[${stdout.length - 400} chars omitted]...\n${stdout.slice(-200)}` : stdout,
      ...(stderr ? { stderrPreview: stderr.length > 400 ? `${stderr.slice(0, 200)}...[truncated]...${stderr.slice(-200)}` : stderr } : {}),
    };
  }

  // grep_search / list_directory / skim_file: just path + count summary
  if (result.name === "grep_search" || result.name === "list_directory" || result.name === "skim_file") {
    const path = typeof args.path === "string" ? args.path : "";
    const count = Array.isArray(output.matches) ? output.matches.length : Array.isArray(output.entries) ? output.entries.length : undefined;
    return {
      ...base,
      ...(path ? { path } : {}),
      ...(count !== undefined ? { matchCount: count } : {}),
      output: `${result.name} ${path} returned ${count ?? "?"} items`,
    };
  }

  // Default: fall back to existing compact renderer.
  return renderToolResultForModel(result, { compact: true, maxOutputChars: 600 });
}

export function buildLiveOptimizationSnapshot(results: ToolResult[]): Record<string, unknown> {
  const recent = results.slice(-40);
  const commandResults = recent.filter((result) => result.name === "bash");
  const readOnlyResults = recent.filter(isReadOnlyToolResult);
  const mutationResults = recent.filter(isMutationOrProducerResult);
  const failed = recent.filter((result) => !result.ok);
  const uniqueCommands = new Set(commandResults.map((result) => normalizeCommandForSignature(getToolResultCommand(result))).filter(Boolean));
  const repeatedCommandCount = commandResults.length - uniqueCommands.size;
  return {
    recentToolCount: recent.length,
    recentFailureCount: failed.length,
    recentReadOnlyCount: readOnlyResults.length,
    recentMutationOrProducerCount: mutationResults.length,
    repeatedCommandCount,
    editLocalityScore: computeEditLocalityScore(recent),
    wastedTrajectoryRatio: computeWastedTrajectoryRatio(recent),
  };
}

export function collectRecentlyTouchedFiles(results: ToolResult[]): string[] {
  return uniqueStrings(
    results
      .slice(-80)
      .flatMap((result) => {
        const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
        const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
        return [args.path, output.path, ...extractFilePathsFromFailure(result)]
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => stripWorkspacePrefix(item))
          .filter((item) => !isGeneratedOrBuildPath(item));
      }),
  );
}

export function computeEditLocalityScore(results: ToolResult[]): number {
  const touched = collectRecentlyTouchedFiles(results);
  const edited = uniqueStrings(
    results
      .filter((result) => ["write_file", "file_edit", "edit_file", "delete_file"].includes(result.name))
      .flatMap((result) => {
        const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
        return typeof args.path === "string" ? [stripWorkspacePrefix(args.path)] : [];
      })
      .filter((item) => !isGeneratedOrBuildPath(item)),
  );
  if (edited.length === 0) return 1;
  const dirs = new Set(edited.map((file) => file.split("/").slice(0, -1).join("/") || "."));
  const breadthPenalty = Math.min(0.8, Math.max(0, edited.length - 4) * 0.08 + Math.max(0, dirs.size - 2) * 0.12);
  const touchPenalty = Math.min(0.2, Math.max(0, touched.length - 12) * 0.01);
  return Number(Math.max(0, 1 - breadthPenalty - touchPenalty).toFixed(3));
}

export function computeWastedTrajectoryRatio(results: ToolResult[]): number {
  if (results.length === 0) return 0;
  const wasted = results.filter((result) => {
    if (!result.ok) return true;
    if (isLowInformationToolResult(result)) return true;
    if (isReadOnlyToolResult(result) && !hasInformativeToolResultOutput(result)) return true;
    return false;
  }).length;
  return Number((wasted / results.length).toFixed(3));
}

function buildTrajectoryEfficiencyMetrics(input: {
  startedAt: number;
  prompt: string;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  completedStepIds: string[];
  executionPlan?: ExecutionPlanStep[];
  currentStepIndex: number;
  explicitVerification?: RuntimeEngineResult["verification"] | undefined;
}): {
  total_runtime_ms: number;
  tool_count: number;
  failure_count: number;
  retry_count: number;
  unique_commands: number;
  repeated_commands: number;
  edited_file_count: number;
  edited_files: string[];
  edit_locality_score: number;
  context_growth_rate: number;
  tool_success_rate: number;
  validation_efficiency: number;
  wasted_trajectory_ratio: number;
  verification_attempts: number;
  completed_steps: number;
  total_steps: number;
  current_step_index: number;
  negative_constraint_count: number;
  feedback_count: number;
} {
  const toolResults = input.toolResults;
  const commandResults = toolResults.filter((result) => result.name === "bash");
  const failed = toolResults.filter((result) => !result.ok);
  const commands = commandResults.map((result) => normalizeCommandForSignature(getToolResultCommand(result))).filter(Boolean);
  const uniqueCommands = new Set(commands);
  const editedFiles = uniqueStrings(
    toolResults
      .filter((result) => ["write_file", "file_edit", "edit_file", "delete_file"].includes(result.name))
      .flatMap((result) => {
        const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
        return typeof args.path === "string" ? [stripWorkspacePrefix(args.path)] : [];
      })
      .filter((file) => !isGeneratedOrBuildPath(file)),
  );
  const buildTestChecks = commandResults.filter((result) => {
    const command = getToolResultCommand(result);
    return isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command) || isBuildArtifactRuntimeCommand(command);
  });
  const passedChecks = buildTestChecks.filter((result) => result.ok).length;
  return {
    total_runtime_ms: Date.now() - input.startedAt,
    tool_count: toolResults.length,
    failure_count: failed.length,
    retry_count: countRetryLikeActions(toolResults),
    unique_commands: uniqueCommands.size,
    repeated_commands: Math.max(0, commands.length - uniqueCommands.size),
    edited_file_count: editedFiles.length,
    edited_files: editedFiles.slice(0, 40),
    edit_locality_score: computeEditLocalityScore(toolResults),
    context_growth_rate: estimateTokens(JSON.stringify(toolResults.map((result) => renderToolResultForModel(result, { compact: true, maxOutputChars: 700 })))) / Math.max(1, toolResults.length),
    tool_success_rate: Number(((toolResults.length - failed.length) / Math.max(1, toolResults.length)).toFixed(3)),
    validation_efficiency: Number((passedChecks / Math.max(1, buildTestChecks.length)).toFixed(3)),
    wasted_trajectory_ratio: computeWastedTrajectoryRatio(toolResults),
    verification_attempts: input.explicitVerification?.attemptCount ?? 0,
    completed_steps: input.completedStepIds.length,
    total_steps: input.executionPlan?.length ?? 0,
    current_step_index: input.currentStepIndex,
    negative_constraint_count: input.negativeConstraints.length,
    feedback_count: input.feedback.length,
  };
}

function countRetryLikeActions(results: ToolResult[]): number {
  const seen = new Set<string>();
  let retries = 0;
  for (const result of results) {
    const signature = makeToolResultActionSignature(result) ?? makeLowInformationToolResultSignature(result);
    if (!signature) continue;
    if (seen.has(signature)) retries += 1;
    seen.add(signature);
  }
  return retries;
}

async function writeTrajectoryMetricsFile(workspaceRoot: string, runId: string, metrics: Record<string, unknown>): Promise<void> {
  const runDir = path.join(getReaperScratchpadPaths(workspaceRoot).logs, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "trajectory-metrics.json"), JSON.stringify({ runId, ...metrics, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function selectContextEfficientRecentResults(results: ToolResult[], count: number, compact: boolean): ToolResult[] {
  const recent = results.slice(-count);
  if (!compact) return recent;

  const selected: ToolResult[] = [];
  const seenLargeReadPaths = new Set<string>();
  for (let i = recent.length - 1; i >= 0; i--) {
    const result = recent[i]!;
    if (result.name === "file_view" && isLargeToolOutput(result)) {
      const key = toolResultPath(result) ?? result.toolCallId;
      if (seenLargeReadPaths.has(key)) continue;
      seenLargeReadPaths.add(key);
    }
    selected.unshift(result);
  }
  return selected.slice(-Math.min(count, 10));
}

function hasRecentLargeToolOutput(results: ToolResult[]): boolean {
  return results.slice(-12).some((result) => isLargeToolOutput(result));
}

function isLargeToolOutput(result: ToolResult): boolean {
  const rendered = result.output === undefined ? "" : typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  return rendered.length > 4500 || (result.name === "file_view" && rendered.split(/\r?\n/).length > 120);
}
function toolResultPath(result: ToolResult): string | undefined {
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof output.path === "string" ? output.path : typeof args.path === "string" ? args.path : undefined;
}
export function renderAgentSourceReliabilityPatterns(role: "planner" | "executor" | "patcher" | "repair" | "recovery"): string {
  const common = [
    "# Agent Reliability Patterns",
    "Use repo-local instructions when they appear in indexed context, especially AGENTS.md, REAPER.md, CLAUDE.md, and .cursorrules. Treat them as project guidance unless they conflict with the user's request or higher-priority Reaper rules.",
    "Operate from current state: task, workspace tree, environment, current step, compacted observations, recent tool results, feedback, and negative constraints. Do not rediscover facts already shown unless a diagnostic or changed file makes them stale.",
    "Use a linear observe-act-check loop. Make one bounded discovery or mutation batch, observe the result, then choose the next dependent action from evidence.",
    "Prefer high-signal bounded reads/searches over whole-repository dumps. Inspect the exact spec, test, config, stack frame, symbol, or artifact that determines acceptance.",
  ];

  if (role === "planner") {
    return [
      ...common,
      "# Architect Planning Discipline",
      "Separate architecture from editing. Study the request and visible code/spec/test context, then give the executor clear instructions, likely files, command hints, success evidence, and boundaries.",
      "Do not include full replacement files, long code listings, or giant patches in the plan. The executor/editor owns concrete file edits.",
      "Plan small acceptance-evidence steps: inspect only what is missing, implement the narrow behavior, run the smallest real check, repair cited failures, then finalize.",
      "When prior execution failed, plan forward from the latest failing artifact or diagnostic. Preserve passed work and avoid restarting scaffolding or broad rewrites.",
    ].join("\n");
  }

  const editorRules = [
    ...common,
    "# Editor Discipline",
    "Before editing an existing file, read the relevant range. Prefer the smallest exact or line-range replacement that preserves surrounding code.",
    "If exact replacement is uncertain or has failed, read the file again and use a line-range edit for the smallest affected region. Do not retry stale old text.",
    "Use whole-file writes only for new files or intentional complete overwrites after reading the file and preserving all required content. Never use placeholders, ellipses, or partial files.",
    "After a mutating action, run the narrowest real syntax/build/test/runtime check that can expose mistakes in the changed behavior.",
    "If a check fails, repair the cited root cause before repeating the command. Do not weaken tests, skip required checks, or edit verifier-owned files to force success.",
    "Shell snippet rule: if a diagnostic or validation command needs compound control flow, function definitions, nested quoting, or many statements, write a temporary script file or use a here-doc instead of cramming it into a single shell one-liner. If a one-liner fails with syntax or quoting errors, do not retry the same shape.",
    "Exact artifact rule: if a verifier compares hashes, checksums, byte-exact text, image fingerprints, counts, ordering, or serialized output, treat any expected-vs-actual mismatch as an artifact correctness failure. Inspect the comparator and generated artifacts, then make deterministic outputs that satisfy the visible contract.",
    "Remote input rule: if exact artifacts depend on an HTTP/API resource, do not dismiss mismatches as provider drift until you have inspected the spec/test, redirects, response format, cache/seed/static options, and local fixtures. Prefer pinned, seeded, cached, or otherwise deterministic retrieval when the service supports it.",
    "Performance-pair rule: when the task asks for baseline and optimized variants, preserve the required relative performance contract. Do not accidentally optimize the baseline or add overhead to the optimized path; profile both and adjust implementation structure before declaring completion.",
  ];

  if (role === "patcher") {
    editorRules.push(
      "Keep patcher responses focused: one diagnosis, one minimal patch surface, and one targeted check when possible. Exit patch mode once the relevant check passes.",
    );
  } else if (role === "repair") {
    editorRules.push(
      "In repair mode, use the latest failure evidence as the source of truth. Make the smallest concrete fix and validate it; do not replan unless repeated evidence proves the current step is structurally wrong.",
    );
  } else if (role === "recovery") {
    editorRules.push(
      "In recovery mode, collapse complexity to the externally visible contract. If internals keep failing, prefer a small adapter, wrapper, shim, or standalone boundary implementation that can be verified honestly.",
    );
  }

  return editorRules.join("\n");
}
function renderEpicStateForPrompt(input: {
  runId: string;
  prompt: string;
  executionPlan?: ExecutionPlanStep[] | undefined;
  currentStepIndex?: number | undefined;
  completedStepIds?: string[] | undefined;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
}): string {
  const tasks = listSessionTasks(undefined, input.runId);
  const plan = input.executionPlan ?? [];
  const completed = new Set(input.completedStepIds ?? []);
  const currentStepIndex = Math.max(0, input.currentStepIndex ?? 0);
  const latestFailure = input.toolResults.slice().reverse().find((result) => !result.ok);
  const archivePointers = [
    input.feedback.length ? "feedback:latest" : "",
    input.negativeConstraints.length ? "do_not_repeat:latest" : "",
    latestFailure ? `tool_result:${latestFailure.toolCallId}` : "",
  ].filter(Boolean);
  return [
    "# EPIC_STATE",
    "Always-resident roadmap memory. Keep this frame active even when tool history is compacted; use archive pointers to retrieve or inspect details instead of discarding the objective.",
    JSON.stringify({
      objective: input.prompt.slice(0, 1000),
      todo_counts: {
        pending: tasks.filter((task) => task.status === "pending").length,
        in_progress: tasks.filter((task) => task.status === "in_progress").length,
        completed: tasks.filter((task) => task.status === "completed").length,
      },
      current_todo: tasks.find((task) => task.status === "in_progress")?.subject ?? null,
      plan_progress: plan.length
        ? {
            total_steps: plan.length,
            current_step_index: currentStepIndex,
            current_step_id: plan[currentStepIndex]?.id ?? null,
            completed_step_ids: [...completed],
            remaining_step_ids: plan.filter((step, index) => !completed.has(step.id) && index >= currentStepIndex).map((step) => step.id),
          }
        : null,
      latest_blocker: latestFailure ? summarizeToolResult(latestFailure, 500) : null,
      archive_pointers: archivePointers,
    }),
  ].join("\n");
}
function renderDiagnosticTargeting(results: ToolResult[]): string {
  const target = getUnresolvedDiagnosticTarget(results);
  if (!target) return "# Diagnostic Targeting\nnone";
  return [
    "# Diagnostic Targeting",
    `Latest unresolved diagnostic target: ${target.path}`,
    `Origin: ${target.commandOrSource.slice(0, 220)}`,
    "Rule: before broad rebuilds, unrelated edits, installs, or cleanup, focus the next high-cost action on this cited artifact. Read/edit/check the cited artifact, or run a narrow command proving it is no longer the failing target.",
    "This rule is language-agnostic and applies to compiler, test, runtime, parser, config, and schema diagnostics.",
  ].join("\n");
}

/**
 * The inventory of tools the model is *not* currently holding a schema for.
 *
 * The wire only carries `CORE_TOOL_NAMES` plus whatever this run has already
 * discovered, and a model can only call what it can see — so without this
 * block the other fifty-odd tools are unreachable in practice: the model has no
 * way to learn that `web_search` or `web_fetch` exist, and
 * `search_tools` is a dead end it has no reason to try. Naming them here, with
 * the one-line description already written for each, is what turns
 * `search_tools` from an unguessable secret into a documented directory.
 *
 * It is rebuilt on every model call while the system prompt itself is not, and
 * that split is the point: the prompt stays byte-identical for provider prefix
 * caching, and the inventory — which legitimately changes mid-run as tools are
 * discovered — travels where it costs one cheap append rather than a cache miss
 * on the whole prefix.
 *
 * Names and one line each, deliberately. A deferred tool's *schema* is what
 * `search_tools` exists to hand over, and printing full argument shapes here
 * would make discovery pointless while spending the context it was meant to
 * save.
 */

/**
 * Words that read as broken when they are the last thing on the line. The
 * truncation is mid-sentence by construction, so it needs to look deliberate
 * rather than cut off.
 */
const TRAILING_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "for", "from", "with", "by",
  "as", "at", "on", "into", "that", "which", "is", "are", "be", "then", "so",
]);

/**
 * One line of a tool description, cut on a word boundary.
 *
 * The first version was `slice(0, 110)`, which severed words in **17 of the 20
 * deferred entries** — `paths be`, `mutation batch. Stores met`, `Supports new
 * file creation (--- /d`. These lines are the entire reason the model knows a
 * tool exists, and 17 of 20 read as a broken listing; a model deciding whether
 * to spend a discovery call on `hook_manager` was shown 110 characters of
 * `hook_manager`'s 527 and no indication the rest mattered.
 *
 * Marking the cut is the point. Without a marker the line reads as the whole
 * description — the difference between "an event hook. Drafts are NOT regis"
 * and "an event hook. Drafts are NOT registered on the live runner until
 * approved. …" is the difference between a model that knows there is more to
 * find and one that thinks it has read the whole thing.
 */
export function summarizeToolDescription(description: string, limit = 110): string {
  const line = description.split("\n")[0]!.trim();
  if (line.length <= limit) return line;

  let cut = line.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(" ");
  // Only honour the boundary when it is not near the start; a single very long
  // token has no good break and a hard cut is the honest answer.
  if (boundary > limit * 0.6) cut = cut.slice(0, boundary);
  const words = cut.split(" ").filter(Boolean);
  while (words.length > 1 && TRAILING_WORDS.has(words[words.length - 1]!.toLowerCase())) {
    words.pop();
  }
  return `${words.join(" ").replace(/[.,;:!?]$/, "")} …`;
}

/**
 * How many deferred tools are spelled out before the list is summarised.
 *
 * This block is in the system prompt on every turn, and each line costs about
 * 35 tokens, so an unbounded list is an unbounded standing cost — the exact
 * problem Code Mode's fixed-size description was arranged to avoid. Extensions
 * register tools into the same registry, so the count is not bounded by
 * Reaper's own catalogue and cannot be reasoned about as if it were.
 *
 * 24 is chosen to be above the registry's current 19 deferred names, so nothing
 * is hidden today and the change is invisible until it is load-bearing. Past
 * that, a model reads a list of 200 tool names no more usefully than a list of
 * 24 plus a count — the *searching* is what finds the right one either way.
 */
const MAX_RENDERED_DEFERRED_TOOLS = 24;

export function renderAvailableTools(
  runId?: string,
  disabledTools: ReadonlySet<string> = EMPTY_TOOL_SET,
): string {
  const discovered = runId ? getDiscoveredTools(runId) : new Set<string>();
  const deferred: string[] = [];
  let offeredCount = 0;
  for (const [name, spec] of Object.entries(toolRegistry)) {
    if (disabledTools.has(name)) continue;
    if (CORE_TOOL_NAMES.has(name) || discovered.has(name)) {
      offeredCount += 1;
      continue;
    }
    deferred.push(`  - ${name}: ${summarizeToolDescription(spec.description)}`);
  }
  if (deferred.length === 0) return "";

  const shown = deferred.slice(0, MAX_RENDERED_DEFERRED_TOOLS);
  const hidden = deferred.length - shown.length;
  return [
    "",
    "# Available tools",
    `You currently hold full schemas for ${offeredCount} tools. ${deferred.length} more are available:`,
    ...shown,
    /*
     * The elision is stated, never silent. A truncated list that reads as
     * complete is worse than the long one it replaced: the model would check it,
     * not find what it wanted, and conclude the capability does not exist.
     * Naming the remainder and pointing at the two ways to reach it keeps the
     * list honest at any length.
     */
    ...(hidden > 0
      ? [
          `  … and ${hidden} more.`,
          "Call `search_tools` with keywords describing what you need, or `select:<name>` to unlock one by name.",
        ]
      : []),
    "",
    "These are real, callable tools whose schemas are withheld only to keep each request small. Call `search_tools` with keywords describing the capability you need, or `select:<name>` to unlock a specific one by name; unlocked tools render with full schemas on your next call. Check this list before concluding a capability is missing, and prefer a listed tool over improvising with bash. When you want several at once, or want to chain them over a lot of data, `eval` can reach every one of them without any of this list growing.",
  ].join("\n");
}

function parsePlannedToolCalls(value: unknown): { tool_calls: ToolCall[]; assistant_message?: string } {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const toolCalls = parseToolCallArray(raw.tool_calls, { context: "executor response", limit: 32 });
  const assistantMessage = typeof raw.assistant_message === "string" ? raw.assistant_message : undefined;
  return {
    tool_calls: toolCalls,
    ...(assistantMessage ? { assistant_message: assistantMessage } : {}),
  };
}

export function parseToolCallArray(value: unknown, options: { context: string; limit: number }): ToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${options.context} tool_calls must be an array when present.`);
  }
  const parsedCalls: ToolCall[] = [];
  const errors: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).tool_calls)) {
      try {
        parsedCalls.push(...parseToolCallArray((item as Record<string, unknown>).tool_calls, { ...options, limit: options.limit - parsedCalls.length }));
        continue;
      } catch (error) {
        errors.push(`tool_calls[${index}].tool_calls: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    const normalized = normalizeToolCallInput(value[index]);
    const parsed = ToolCallSchema.safeParse(normalized);
    if (parsed.success) {
      parsedCalls.push(parsed.data);
      continue;
    }
    errors.push(`tool_calls[${index}]: ${summarizeToolCallParseFailure(normalized, parsed.error)}`);
  }
  if (errors.length > 0) {
    throw new Error(`${options.context} contained unparseable tool calls; none were dropped. ${errors.join(" | ")}`);
  }
  return parsedCalls.slice(0, options.limit);
}

function summarizeToolCallParseFailure(normalized: unknown, error: unknown): string {
  const toolName =
    normalized && typeof normalized === "object" && "name" in normalized
      ? String((normalized as { name?: unknown }).name)
      : "unknown";
  const args =
    normalized && typeof normalized === "object" && "args" in normalized
      ? JSON.stringify((normalized as { args?: unknown }).args).slice(0, 500)
      : "no args";
  const issueSummary =
    error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown }).issues)
      ? (error as { issues: Array<{ path?: unknown; message?: unknown }> }).issues
          .slice(0, 5)
          .map((issue) => `${Array.isArray(issue.path) ? issue.path.join(".") : ""}: ${String(issue.message ?? "invalid")}`)
          .join("; ")
      : String(error);
  return `name=${toolName}, args=${args}, errors=${issueSummary}`;
}
function normalizeToolCallInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const outer = input as Record<string, unknown>;
  const raw =
    outer.tool_call && typeof outer.tool_call === "object" && !Array.isArray(outer.tool_call)
      ? (outer.tool_call as Record<string, unknown>)
      : outer;
  const functionCall = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : undefined;
  const rawName =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.tool_name === "string"
        ? raw.tool_name
        : typeof functionCall?.name === "string"
            ? functionCall.name
            : typeof raw.tool === "string"
              ? raw.tool
              : typeof raw.toolName === "string"
                ? raw.toolName
                : typeof raw.id === "string" && isKnownToolName(normalizeToolName(raw.id))
                  ? raw.id
                : typeof raw.type === "string" && raw.type !== "function" && raw.type !== "tool_call"
                  ? raw.type
                  : raw.name;
  let name = typeof rawName === "string" ? normalizeToolName(rawName) : rawName;
  const functionArguments = parseToolArgumentObject(functionCall?.arguments);
  const rawArgsValue =
    raw.args ?? raw.arguments ?? raw.tool_input ?? raw.parameters ?? functionArguments ?? raw.input;
  const parsedRawArgs = parseToolArgumentObject(rawArgsValue);
  const rawArguments =
    parsedRawArgs && typeof parsedRawArgs === "object" && !Array.isArray(parsedRawArgs)
      ? parsedRawArgs
      : {};
  const rawArgs =
    Object.keys(rawArguments as Record<string, unknown>).length > 0
      ? (rawArguments as Record<string, unknown>)
      : raw.file && typeof raw.file === "object" && !Array.isArray(raw.file)
        ? (raw.file as Record<string, unknown>)
        : extractTopLevelToolArgs(raw);
  const args = { ...rawArgs };
  if (name !== "bash") delete args.description;
  delete args.reason;
  delete args.explanation;
  /*
   * A model that emits a pid of 0 or a negative number is not targeting a
   * process; it is emitting a placeholder. Clamping to 1 makes the call target
   * *something* real, which is worse than letting it fail — the call is now
   * aimed at an unrelated process instead of saying it had no target. Carry the
   * value through and let `job` reject it.
   */
  if (typeof args.path !== "string") {
    for (const key of ["file_path", "filepath", "filePath", "file", "targetPath"]) {
      if (typeof args[key] === "string") {
        args.path = args[key];
        delete args[key];
        break;
      }
    }
  }
  if (name === "write_file") {
    normalizeStringAlias(args, "content", ["contents", "body", "text", "data", "source"]);
  }
  if (name === "advance_step") {
    normalizeStringAlias(args, "stepId", ["step_id", "step", "id"]);
    if (typeof args.summary !== "string") {
      for (const key of ["evidence", "note", "message", "status"]) {
        if (typeof args[key] === "string" && args[key].trim()) {
          args.summary = args[key];
          break;
        }
      }
      if (typeof args.summary !== "string" && Array.isArray(args.evidence)) {
        const evidenceSummary = args.evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("; ");
        if (evidenceSummary) args.summary = evidenceSummary;
      }
    }
    if (typeof args.evidence === "string") {
      args.evidence = [args.evidence];
    }
  }
  if (name === "web_search") {
    normalizeIntegerRange(args, "maxResults", 10, 20);
    normalizeIntegerRange(args, "scrapePages", 10, 20);
  }
  if (name === "edit_file" && Array.isArray(args.edits)) {
    args.edits = args.edits.map((edit) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
      const normalizedEdit = { ...(edit as Record<string, unknown>) };
      normalizeStringAlias(normalizedEdit, "oldString", ["old_string", "old_str", "oldText", "old_text", "search", "find"]);
      normalizeStringAlias(normalizedEdit, "newString", ["new_string", "new_str", "newText", "new_text", "replacement", "replace"]);
      return normalizedEdit;
    });
  }
  if (name === "edit_file" && !Array.isArray(args.edits) && typeof args.path === "string" && typeof args.instructions === "string") {
    delete args.instructions;
  }
  const stripResult = stripUnknownToolArgs(typeof name === "string" ? name : "", args);
  if ("cleaned" in stripResult) {
    for (const key of Object.keys(args)) delete args[key];
    Object.assign(args, stripResult.cleaned);
  }
  const id =
    typeof raw.id === "string" && raw.id.trim() && raw.id !== rawName
      ? raw.id
      : typeof raw.tool_call_id === "string" && raw.tool_call_id.trim()
        ? raw.tool_call_id
        : typeof raw.call_id === "string" && raw.call_id.trim()
          ? raw.call_id
          : randomUUID();
  return {
    id,
    name,
    args,
  };
}

function parseToolArgumentObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const repaired = repairJsonLikeObject(trimmed);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        return value;
      }
    }
    return value;
  }
}

function repairJsonLikeObject(input: string): string | undefined {
  const start = input.search(/[\{\[]/);
  if (start < 0) return undefined;
  let json = "";
  const stack: ("{" | "[")[] = [];
  let inString = false;
  let escape = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index]!;
    if (escape) {
      escape = false;
      json += char;
      continue;
    }
    if (char === "\\") {
      escape = true;
      json += char;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      json += char;
      continue;
    }
    if (inString) {
      json += char;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      json += char;
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) continue;
      stack.pop();
      json += char;
      continue;
    }
    json += char;
  }
  if (!json) return undefined;
  if (inString) json += "\"";
  while (stack.length > 0) {
    const last = stack.pop();
    json += last === "{" ? "}" : "]";
  }
  return json;
}

function normalizeStringAlias(args: Record<string, unknown>, targetKey: string, aliases: string[]): void {
  if (typeof args[targetKey] === "string") return;
  for (const key of aliases) {
    if (typeof args[key] === "string") {
      args[targetKey] = args[key];
      delete args[key];
      return;
    }
  }
}

function normalizeNumberAlias(args: Record<string, unknown>, targetKey: string, aliases: string[]): void {
  if (typeof args[targetKey] === "number") return;
  for (const key of aliases) {
    if (typeof args[key] === "number") {
      args[targetKey] = args[key];
      delete args[key];
      return;
    }
  }
}

function normalizeIntegerRange(args: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  args[key] = Math.max(min, Math.min(max, Math.trunc(value)));
}

function extractTopLevelToolArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set([
    "id",
    "tool_call_id",
    "call_id",
    "name",
    "tool_name",
    "tool",
    "toolName",
    "type",
    "function",
    "file",
    "args",
    "arguments",
    "tool_input",
    "parameters",
    "input",
  ]);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !excluded.has(key)));
}


function normalizeToolName(name: string): string {
  const normalized = name.trim();
  const normalizedLower = normalized.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    bash: "bash",
    read: "file_view",
    readfile: "file_view",
    list: "list_directory",
    ls: "list_directory",
    grep: "grep_search",
    search: "grep_search",
    write: "write_file",
    write_to_file: "write_file",
    writefile: "write_file",
    edit: "file_edit",
    replace: "file_edit",
    delete: "delete_file",
    rm: "delete_file",
    advance: "advance_step",
    replace_in_file_line_range: "file_edit",
    replace_in_file_exact: "file_edit",
    edit_file_line_range: "file_edit",
    line_range_replace: "file_edit",
  };
  return aliases[normalizedLower] ?? aliases[normalized.toLowerCase()] ?? normalized;
}


function shouldCleanupBackgroundAfterBatch(
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
  backgroundProcesses: Array<{ pid: number; status: "running" | "finished"; exitCode: number | null }>,
): boolean {
  if (!backgroundProcesses.some((item) => item.status === "running")) return false;
  const currentIds = new Set(toolCalls.map((call) => call.id));
  const currentResults = toolResults.filter((result) => result.toolCallId !== undefined && currentIds.has(result.toolCallId));
  const startedBackground = currentResults.some(
    (result) => result.name === "bash" && result.ok && result.output && typeof result.output === "object" && "pid" in result.output,
  );
  const foregroundCheckSucceeded = currentResults.some((result) => {
    if (result.name !== "bash" || !result.ok) return false;
    const cmd = typeof (result.args as { cmd?: unknown }).cmd === "string" ? (result.args as { cmd: string }).cmd : "";
    if (!/\b(curl|wget|test|spec|pytest|jest|vitest|mocha|node\s+--test|go\s+test|cargo\s+test|check|smoke)\b/i.test(cmd)) return false;
    return !(result.output && typeof result.output === "object" && "pid" in result.output);
  });
  return startedBackground && foregroundCheckSucceeded;
}
function getBoundaryPivotInstruction(toolResults: ToolResult[]): { feedback: string; negativeConstraint: string } | undefined {
  const recent = toolResults.slice(-80);
  const overpatchedBlocks = recent.filter((result) => !result.ok && result.error?.code === "overpatched_source_file_blocked");
  if (overpatchedBlocks.length < 2) return undefined;
  const compileFailures = recent.filter((result) => {
    if (result.ok || result.name !== "bash") return false;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
    return isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(text);
  });
  if (compileFailures.length < 2) return undefined;
  const blockedPaths = [...new Set(overpatchedBlocks.map((result) => describeToolResultTarget(result)).filter(Boolean))].slice(0, 4);
  const pathText = blockedPaths.length ? blockedPaths.join(", ") : "the repeatedly failing source files";
  return {
    feedback:
      `Boundary-pivot required: repeated edits to ${pathText} caused repeated build/compile failures. Replan around the externally required contract instead of continuing brittle internal surgery. Identify the required command/API/output artifacts from visible specs/tests, then implement the smallest adapter, wrapper, standalone tool, compatibility layer, or generated deliverables that satisfies that contract and can be verified.`,
    negativeConstraint:
      `Do not continue repeated invasive edits to ${pathText}. Prefer an acceptance-first boundary implementation: wrapper, adapter, standalone executable/script, compatibility shim, or direct generation of required artifacts when that is valid for the task. Only return to those internals after proving no boundary path can satisfy the visible tests/specs.`,
  };
}

function getGraphRecursionLimit(): number {
  const raw = getEngineTunables().langgraphRecursionLimit;
  const parsed = Number(raw);
  // Honor any sane positive configured value (the config default is 50 —
  // the old `>= 100` gate silently discarded it and returned a hard-coded
  // 8000, so the tunable was dead). Clamp to [1, 100000] to avoid a
  // misconfigured 0/negative/gigantic value unbounding the live loop.
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.min(100_000, Math.max(1, Math.floor(parsed)));
  }
  return 50;
}


function getMaxRescueAttemptsPerDiagnostic(): number {
  const raw = getEngineTunables().rescueMaxAttemptsPerDiagnostic;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return 6;
}

function getMaxRescueStagnantTurns(): number {
  const raw = getEngineTunables().rescueMaxStagnantTurns;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return 4;
}

function readJsonIfExistsSync(filePath: string): Record<string, unknown> | undefined {
  try {
    // Use the already-imported `node:fs`/`node:path` modules at the top
    // of this file. The previous `require("node:fs")` is undefined in
    // ESM (tsx mode) and silently failed, causing the engine's
    // local mergeWorkspaceConfigSync to drop the on-disk config.
    if (!existsSync(filePath)) {
      if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
        process.stderr.write(`[readJson:debug] existsSync=false for ${filePath}\n`);
      }
      return undefined;
    }
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
        process.stderr.write(`[readJson:debug] read OK, keys=${Object.keys(parsed as any).join(",")}\n`);
      }
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch (e: any) {
    if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
      process.stderr.write(`[readJson:debug] catch: ${e?.message ?? String(e)}\n`);
    }
    return undefined;
  }
}

function mergeWorkspaceConfigSync(explicit: unknown, workspaceRoot: string): unknown {
  let fromDisk: Record<string, unknown> | undefined;
  for (const candidate of ReaperConfigSearchPaths(workspaceRoot)) {
    const loaded = readJsonIfExistsSync(candidate);
    if (loaded) {
      fromDisk = loaded;
      break;
    }
  }
  if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
    process.stderr.write(`[engine-merge:debug] workspaceRoot=${workspaceRoot} candidates=${JSON.stringify(ReaperConfigSearchPaths(workspaceRoot))} fromDisk=${fromDisk ? Object.keys(fromDisk).join(",") : "<none>"} explicit=${explicit && typeof explicit === "object" ? Object.keys((explicit as any)).join(",") : "<none>"}\n`);
  }
  if (!fromDisk) return explicit;
  if (!explicit || typeof explicit !== "object" || Array.isArray(explicit)) {
    return fromDisk;
  }
  // Deep merge to preserve sibling profiles (e.g. secondary_model alongside
  // default_model). OMP port: #21 Promote-Context-Model layer reads sibling
  // profiles from the parsed config.
  const merged: Record<string, unknown> = deepMerge(fromDisk, explicit as Record<string, unknown>);
  // Strip legacy `tokenBudget` top-level field. It is consumed by
  // `resolveSoftCapFromWorkspaceConfig` (workspace-aware) BEFORE the
  // engine constructor runs, and is not part of the strict
  // ReaperConfigSchema. Removing it avoids the strict-mode
  // "unrecognized_keys" rejection.
  delete merged.tokenBudget;
  if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
    process.stderr.write(`[engine-merge:debug] merged.models=${Object.keys((merged as any).models || {}).length}\n`);
  }
  return merged;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export async function resolvePlannerMaxTokensForProfile(
  input: { modelGateway: { resolveRole: (role: ModelRole) => Promise<ResolvedModelProfile> | ResolvedModelProfile } },
): Promise<number> {
  try {
    const resolved = await Promise.resolve(input.modelGateway.resolveRole("default_model"));
    const provider = String(resolved.provider ?? "").toLowerCase();
    const model = String(resolved.model ?? "").toLowerCase();
    if (provider === "minimax" || model.includes("minimax")) return 16384;
    if (provider === "deepinfra") return 8192;
    if (provider === "anthropic" || model.startsWith("claude")) return 8192;
    if (provider === "openrouter") return 8192;
  } catch {
    // ignore and fall through to default
  }
  return 6144;
}
