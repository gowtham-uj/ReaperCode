import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir,  readFile,  writeFile } from "node:fs/promises";
import path from "node:path";


import { parseReaperConfig, type ReaperConfig } from "../config/model-config.js";
import { applyConfigToTunables, getEngineTunables } from "../config/config-tunables.js";
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
import { generateFinalSummary, summarizeExplicitToolRun } from "./final-summary.js";
import { classifyRunFinalStatus, persistRunFailure } from "./run-finalize.js";
import { buildGeneralAgentTools, buildAgentToolDescriptor, userPromptRequestsScratchpad, type AgentToolDescriptor } from "./agent-tools.js";
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
import { pushModelCallContext } from "../model/observability.js";
import { setModelCallLogContext } from "../logging/model-call-log.js";
import { appendFailureMemory, loadRecentFailureMemory } from "../recovery/failure-memory.js";
import { commitVerifiedRunKnowledge, loadVerifiedLessons } from "../recovery/verified-memory.js";
import { RecoverySession } from "../recovery/session.js";
import {ToolExecutor} from "../tools/executor.js";
import type { ShellRunner} from "../tools/executor.js";
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
import { isKnownToolName, stripUnknownToolArgs } from "./tool-args.js";
import {
  getShellCommandArg} from "./tool-call-utils.js";
import {
  getUnresolvedDiagnosticTarget, 
  isInternalGuardBlockedResult, 
  normalizeDiagnosticCommand} from "./diagnostic-target.js";
import { classifyShellCommandSemantics } from "../tools/command-semantics.js";
import { loadMcpServersFromFile } from "../tools/mcp/config.js";
import { MergedToolRegistry } from "../tools/mcp/registry.js";
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
import { registerCleanup, runCleanupFunctions, setActiveRunDir, installCrashHandlers } from "./cleanup-registry.js";
import { buildDerivedSecretEncodingFeedback } from "./derived-secret-encoding.js";
import { buildSessionMetricsSummary } from "./session-metrics.js";
import { collectWorkspaceDiff, runFreshContextDiffReview } from "../verify/diff-review.js";
import { buildRescueHypothesisLedger, renderRescueHypothesisLedger } from "./hypothesis-ledger.js";
import { printToolCalls, printTurnHeader } from "./session-printer.js";
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
}

export interface RuntimeEngineResult {
  state: ReturnType<typeof bootPhase0Runtime>["state"];
  toolResults: ToolResult[];
  assistantMessage: string;
  events: AgentEventEnvelope[];
  trajectoryPath: string;
  contentFingerprint?: string;
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

const LIVE_CONVERSATION_SNAPSHOT = "live-conversation.json";

async function loadLiveConversationSnapshot(runDir: string): Promise<GenerateRequest["messages"] | undefined> {
  if (!process.env.REAPER_RESUME_RUN_ID) return undefined;
  try {
    const raw = await readFile(path.join(runDir, LIVE_CONVERSATION_SNAPSHOT), "utf8");
    const parsed = JSON.parse(raw) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) return undefined;
    const messages = parsed.messages.filter(
      (message): message is GenerateRequest["messages"][number] =>
        Boolean(message) &&
        typeof message === "object" &&
        typeof (message as { role?: unknown }).role === "string" &&
        typeof (message as { content?: unknown }).content === "string",
    );
    return messages.length > 0 ? messages : undefined;
  } catch {
    return undefined;
  }
}

/** Ungated snapshot reader for run-end journaling (the loader above is
 *  crash-resume only). Returns the POST-TRANSFORM conversation exactly
 *  as the context-engineering layers left it. */
async function readFinalConversationSnapshot(runDir: string): Promise<GenerateRequest["messages"] | undefined> {
  try {
    const raw = await readFile(path.join(runDir, LIVE_CONVERSATION_SNAPSHOT), "utf8");
    const parsed = JSON.parse(raw) as { messages?: unknown };
    return Array.isArray(parsed.messages) ? (parsed.messages as GenerateRequest["messages"]) : undefined;
  } catch {
    return undefined;
  }
}

async function persistLiveConversationSnapshot(runDir: string, messages: GenerateRequest["messages"]): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, LIVE_CONVERSATION_SNAPSHOT),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      messages: redactSecrets(messages),
    }, null, 2),
    "utf8",
  );
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

export class RuntimeEngine {
  private readonly config: ReaperConfig;
  private trajectoryLogger: TrajectoryLogger;
  private ctxHooks?: ContextEngineeringHooks;

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
    // Apply the config to the runtime-tunables cache so every module
    // reads from a single source of truth (the config file). No env
    // fallbacks — the engine rejects if the config is incomplete.
    applyConfigToTunables(this.config);
    this.trajectoryLogger = new TrajectoryLogger(input.workspaceRoot, this.config.logging);
  }

  static shouldHandle(input: RuntimeEngineInput): boolean {
    const request = parseAgentRequestEnvelope(input.requestEnvelope);
    const hasExplicitToolCalls = Array.isArray(request.payload.tool_calls) && request.payload.tool_calls.length > 0;
    return hasExplicitToolCalls || !input.modelGateway || Boolean(input.modelGateway);
  }

  async run(): Promise<RuntimeEngineResult> {
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
      } catch (error) {
        if ((error as { code?: string }).code === "ProviderNotReady") throw error;
        // Other errors during preflight (gateway unreachable, schema
        // mismatch) are not the user's missing-API-key case — fall through
        // and let the provider's own first call surface the problem.
      }
    }
    const initialRequest = parseAgentRequestEnvelope(this.input.requestEnvelope);
    const runContext = createReaperRunContext(this.input.workspaceRoot, initialRequest);
    await ensureReaperRunContext(runContext, initialRequest);
    await writeLatestRunPointer(this.input.workspaceRoot, runContext);
    clearSessionTasks(runContext.runId);
    clearDiscoveredTools(runContext.runId);
    this.trajectoryLogger = new TrajectoryLogger(this.input.workspaceRoot, { ...this.config.logging, runId: runContext.runId });
    setActiveRunDir(runContext.runDir);
    installCrashHandlers();
    // Cache-friendly system-prompt prefix for provider prompt caching. Set
    // once per run so runtime model calls share the same cacheable prefix.
    //
    // WORKFLOW 2 INVARIANT: GenerateRequest.system must remain
    // byte-identical across compaction and cockpit refresh. Tool
    // inventory is dynamic — to keep system bytes truly stable we
    // build the inventory once at run start and reuse the exact bytes
    // on every model call. We pass an empty tools snapshot here so the
    // inventory block is omitted entirely; the actual API tool[]
    // schemas still ship on the wire via `turnRequest.tools` so the
    // model has every capability, but the system-prompt prefix stays
    // identical across turns.
    const systemPromptPrefix = MAIN_AGENT_SYSTEM_PROMPT_TEXT;
    // Ensure per-call JSON + readable .txt transcripts are written under
    // `.reaper/runs/<runId>/model-calls/` for every generate/stream.
    setModelCallLogContext({
      workspaceRoot: this.input.workspaceRoot,
      runId: runContext.runId,
    });
    const releaseModelCallContext = pushModelCallContext({
      workspaceRoot: this.input.workspaceRoot,
      runId: runContext.runId,
      sessionId: runContext.sessionId,
      traceId: runContext.traceId,
      source: "runtime",
      callId: runContext.runId,
      promptPreview: String(initialRequest.payload?.prompt ?? "").slice(0, 500),
      system: systemPromptPrefix,
    });
    try {
      return await this.runInner({ startedAt, initialRequest, runContext, systemPromptPrefix });
    } finally {
      releaseModelCallContext();
      setModelCallLogContext(undefined);
    }
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
    let mcpRegistry: MergedToolRegistry | undefined;

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

      if (this.config.mcp?.enabled) {
        mcpRegistry = new MergedToolRegistry();
        mcpRegistry.setWorkspaceRoot(this.input.workspaceRoot);
        const serverConfigs = [...(this.config.mcp.servers ?? []), ...loadMcpServersFromFile(this.input.workspaceRoot)];
        for (const serverConfig of serverConfigs) {
          await mcpRegistry.addMcpServer(serverConfig).catch((error) => {
            console.warn(`[runtime-engine] MCP server '${serverConfig.name}' failed to load:`, error);
          });
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
        ...(this.config?.security?.childEnvAllowlist ? { childEnvAllowlist: this.config.security.childEnvAllowlist } : {}),
        recoverySession,
        config: this.config,
        trajectoryLogger: this.trajectoryLogger,
        auditLogger,
        runDir: runContext.runDir,
        artifactsDir: runContext.artifactsDir,
        ...(this.input.shellRunner ? { shellRunner: this.input.shellRunner } : {}),
        ...(mcpRegistry ? { mcpRegistry } : {}),
      });

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
        ...(mcpRegistry ? { mcpRegistry } : {}),
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


      const allGeneralAgentTools = buildGeneralAgentTools(getDiscoveredTools(getBoot().state.runId));
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
        let incompleteRecoveryAttempts = 0;
        let emptyStopRetries = 0;
        let prematureStopNudges = 0;
        const EMPTY_STOP_MAX_RETRIES = 3;
        const PREMATURE_STOP_MAX_NUDGES = 2;
        let terminalRuntimeBlocker: RuntimeBlocker | undefined;
        const rawPromptValue = getRequest().payload.prompt;
        const rawUserPrompt = typeof rawPromptValue === "string" ? rawPromptValue : "";
        const resumedConversation = await loadLiveConversationSnapshot(runContext.runDir);
        const liveConversation: GenerateRequest["messages"] = resumedConversation ?? [];
        if (resumedConversation) {
          // Strip any cockpit text that older runs may have persisted
          // into the snapshot. The runtime no longer inserts cockpits,
          // so a stale one in the snapshot would confuse the model with
          // outdated workspace context. We do not re-insert anything;
          // the new code path (above) appends the raw prompt directly.
          replaceConversationMessages(
            liveConversation,
            stripCockpitFromMessages(liveConversation),
          );
          await this.trajectoryLogger.write({
            event_id: randomUUID(),
            run_id: getBoot().state.runId,
            session_id: getBoot().state.sessionId,
            trace_id: getBoot().state.runId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "assistant_message",
            level: getBoot().state.logLevel,
            content: `[resume] restored ${resumedConversation.length} live conversation message(s) from prior run snapshot`,
          });
        }

        // Soft-context continuity: prepend session-resume re-anchor when
        // onBoot stashed one and this is a fresh (non-snapshot) conversation.
        if (!resumedConversation) {
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
            // Prior-session turns must PRECEDE this run's request so the
            // conversation stays chronological and the new prompt keeps
            // recency position.
            const resumeMessages: unknown[] = [];
            if (reAnchor.length > 0) {
              resumeMessages.push({ role: "user", content: reAnchor });
            }
            resumeMessages.push(...(rehydratedMessages as unknown[]));
            liveConversation.unshift(...(resumeMessages as any[]));
            // Session journaling slices the run's NEW turns off this prefix.
            runState.rehydratedCount = resumeMessages.length;
            runState.sessionResume = undefined;
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
        await persistLiveConversationSnapshot(runContext.runDir, liveConversation);

        const softCap = getBoot().state.tokenBudget?.softCap ?? 270_000;

        while (true) {
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
            tools: buildGeneralAgentTools(getDiscoveredTools(getBoot().state.runId)),
          });
          // WORKFLOW 2: System bytes are built ONCE per autonomous run
          // (see `run()` -> `systemPromptPrefix`) and reused on every
          // model call. Dynamic tool inventory ships on the wire via
          // `turnRequest.tools`; the system string itself stays byte-
          // identical so provider prompt caches hit reliably across
          // compaction and cockpit refresh.
          const currentSystem = systemPromptPrefix;

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
        // carried inside the cockpit block. On subsequent iterations
        // the prompt is already in `liveConversation`, so we skip.
        const hasUserPromptAlready = liveConversation.some(
          (m) => m.role === "user" && (m as { name?: string }).name === CURRENT_REQUEST_MESSAGE_NAME,
        );
        if (!hasUserPromptAlready && rawUserPrompt) {
          liveConversation.push({ role: "user", name: CURRENT_REQUEST_MESSAGE_NAME, content: rawUserPrompt });
          await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
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
            this.input.hooks
              ? {
                  onMessageDelta: async (text) => {
                    await this.input.hooks!.emit({
                      name: "AssistantMessageDelta",
                      payload: { text, role: "assistant", done: false },
                      blockable: false,
                    });
                  },
                  onReasoningDelta: async (text) => {
                    await this.input.hooks!.emit({
                      name: "ReasoningDelta",
                      payload: { text, done: false },
                      blockable: false,
                    });
                  },
                }
              : undefined,
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
            const feedback =
              `Your previous tool_calls were rejected by the runtime schema and were NOT executed:\n${detail}\n` +
              `Fix the arguments (or tool name) and emit valid tool_calls. Do not claim those tools already ran.`;
            liveConversation.push({
              role: "assistant",
              content: turn.content ?? "",
            });
            liveConversation.push({ role: "user", content: feedback });
            await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
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
              terminalRuntimeBlocker = {
                source: "model",
                code: "main_agent_transport_error",
                message: assistantText || "Main-agent provider transport retries were exhausted.",
              };
            }
            if (
              assistantText
              && hasUnexecutedActionPromise(assistantText)
              && prematureStopNudges < PREMATURE_STOP_MAX_NUDGES
              && (!turn.finishReason || turn.finishReason === "stop" || turn.finishReason === "end_turn")
            ) {
              prematureStopNudges += 1;
              liveConversation.push({ role: "assistant", content: turn.content ?? "" });
              liveConversation.push({
                role: "user",
                content:
                  "Your previous response promised a concrete action but emitted no structured tool_calls, " +
                  "so that action did not occur. Do not narrate a future action. Emit the required tool_call now, " +
                  "or, if every requested artifact and check already exists, return a final evidence summary with " +
                  "no future-action language.",
              });
              await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
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
              await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
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
            if (turn.content) {
              liveConversation.push({ role: "assistant", content: turn.content });
              await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
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
                  await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
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
              break;
            }
            continue;
          }
          // 1. Push the assistant message FIRST (the reference loop's order).
          liveConversation.push({
            role: "assistant",
            content: turn.content ?? "",
            tool_calls: tc.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: {
                name: c.name,
                arguments: JSON.stringify((c.args ?? {}) as Record<string, unknown>),
              },
            })),
          });
          await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
          // 2. Execute tools in parallel via the scheduler (island
          // partitioner). The scheduler returns one result per original
          // call in the model's batch, in original order. If a tool
          // call somehow misses a result, fall through to executing it
          // directly so the model still gets the real tool output
          // rather than a synthetic placeholder. We never invent a
          // "not_executed_due_to_prior_failure" or any other synthetic
          // tool result; the model always sees the real outcome of
          // the tool it asked for.
          const liveExecutor = executor!;
          const liveRecovery = getRecoverySession();
          const scheduled = await executeToolCalls(
            tc,
            liveExecutor,
            liveRecovery,
            this.input.abortSignal,
          );
          const currentBatchResults: ToolResult[] = [];
          for (let i = 0; i < tc.length; i += 1) {
            const call = tc[i]!;
            const id = call.id;
            let result = scheduled.results[i];
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
            liveConversation.push({
              role: "tool",
              tool_call_id: id,
              is_error: !result.ok,
              content: markTrust(rawToolContent, toolContentTrust, result.name),
              timestamp: Date.now(),
            } as any);
            await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
          }
          if (scheduled.aborted) {
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
              await persistLiveConversationSnapshot(runContext.runDir, liveConversation);
            }
          } catch { /* best-effort */ }
          continue;
        }
        await logModelResponseTrace({
          trajectoryLogger: this.trajectoryLogger,
          runId: getBoot().state.runId,
          sessionId: getBoot().state.sessionId,
          traceId: getBoot().state.runId,
          level: getBoot().state.logLevel,
          source: "main_agent_live",
          assistantMessage: lastAssistantMessage,
          toolCalls: [],
        });
        await logAssistantMessageTrace({
          trajectoryLogger: this.trajectoryLogger,
          runId: getBoot().state.runId,
          sessionId: getBoot().state.sessionId,
          traceId: getBoot().state.runId,
          level: getBoot().state.logLevel,
          source: "main_agent_live",
          content: lastAssistantMessage,
        });
        // We have already executed everything; the engine's downstream
        // nodes should not re-execute. Pass empty plannedToolCalls.
        return {
          plannedToolCalls: [],
          assistantMessage: lastAssistantMessage,
          events: [...state.events, ...liveEvents],
          feedback: state.feedback,
          runtimeBlockers: terminalRuntimeBlocker
            ? [...state.runtimeBlockers, terminalRuntimeBlocker]
            : state.runtimeBlockers,
          toolResults: [...(state.toolResults ?? []), ...liveToolResults],
          iteration: state.iteration + 1,
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
        // Non-transport error from the model call. The runtime never
        // marks the run as completion-gate-exhausted; the model owns
        // the stop. We surface the error to the model as a normal
        // final assistant message and let summarize pick it up on the
        // next pass. We do not synthesize a fresh LLM summary here.
        return {
          plannedToolCalls: [],
          assistantMessage: message,
          feedback: [...state.feedback, message],
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
        ...(mcpRegistry ? { mcpRegistry } : {}),
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
      const allowedToolCalls = executableToolCalls;
      const blockedBeforeScheduling: ToolResult[] = [];
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
        ...(mcpRegistry ? { mcpRegistry } : {}),
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
      const transportFailed = state.runtimeBlockers.some((blocker) => blocker.code === "main_agent_transport_error");
      if (!transportFailed) {
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
	            || hasPassingGroundedVerification(state.toolResults, getRequest())
	            || hasObservedPassingVerification(state.toolResults)
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
	      const mergedMetrics = { ...metrics, ...sessionMetrics };
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
	          verification_attempts: metrics.verification_attempts,
	          total_runtime_ms: metrics.total_runtime_ms,
	          ...sessionMetrics,
	        });
	        await writeTrajectoryMetricsFile(this.input.workspaceRoot, activeBoot.state.runId, mergedMetrics);
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
    const mcpRegistryInstance = mcpRegistry;
    const unregisterExecutorCleanup = executorInstance
      ? registerCleanup(async () => {
          await executorInstance.cleanupBackgroundProcesses("runtime_finished");
        })
      : undefined;
    const unregisterMcpCleanup = mcpRegistryInstance
      ? registerCleanup(async () => {
          await (mcpRegistryInstance as any).closeAll?.().catch(() => undefined);
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
        ...(finalState.explicitVerification ? { verification: finalState.explicitVerification } : {}),
      };
      const finalStatus = classifyRunFinalStatus(finalState as unknown as Parameters<typeof classifyRunFinalStatus>[0]);

      // ─── Context-engineering: RUN-COMPLETE ───────────────────────────────
      try {
        const ctxHooks = this.ctxHooks;
        if (ctxHooks) {
          const usedChars = JSON.stringify(finalState.toolResults ?? []).length
            + (finalState.assistantMessage ?? "").length;
          const finalConversation = finalBoot.state.namedSession
            ? await readFinalConversationSnapshot(runContext.runDir)
            : undefined;
          await ctxHooks.onRunComplete({
            workspaceRoot: this.input.workspaceRoot,
            runId: finalBoot.state.runId,
            sessionId: finalBoot.state.sessionId,
            traceId: finalBoot.state.runId,
            ...(finalBoot.state.namedSession ? { namedSession: finalBoot.state.namedSession } : {}),
            ...(finalBoot.state.namedSession
              ? {
                  userPrompt: extractUserIntentText(
                    typeof getRequest().payload.prompt === "string" ? (getRequest().payload.prompt as string) : "",
                  ),
                }
              : {}),
            ...(finalConversation ? { conversation: finalConversation } : {}),
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
      // cleanup but exceptions bypass it.
      clearRunState(runContext.runId);
      throw error;
    } finally {
      unregisterExecutorCleanup?.();
      unregisterMcpCleanup?.();
      await runCleanupFunctions();
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
  // `file_scroll`, `file_find`, and `file_edit` directly — no legacy aliases or
  // short-name renames (`read`/`edit`/`write`).
  if (writeCount < 20) {
    return toCanonicalBuildFastStartTools(tools);
  }
  return tools;
}

function toCanonicalBuildFastStartTools(tools: AgentToolDescriptor[]): AgentToolDescriptor[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const base = [
    byName.get("write_file"),
    byName.get("file_edit"),
    byName.get("bash"),
    byName.get("file_view"),
    byName.get("file_scroll"),
    byName.get("file_find"),
    byName.get("list_directory"),
    byName.get("grep_search"),
    byName.get("search_tools"),
  ].filter((tool): tool is AgentToolDescriptor => Boolean(tool));
  // Include scratchpad only when already promoted (user prompt requested it).
  const scratch = byName.get("scratchpad");
  return scratch ? [...base, scratch] : base;
}

export function selectMainAgentMaxTokensForTurn(input: {
  request: AgentRequestEnvelope;
  state: Pick<GraphState, "toolResults">;
}): number {
  if (!detectBuildLikeTask(input.request)) return 32_000;
  const writeCount = input.state.toolResults.filter((result) =>
    result.ok && ["write_file", "replace_in_file", "edit_file", "delete_file"].includes(result.name),
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

function makeAdvisoryToolResult(call: AdvisoryToolCall, output: unknown): ToolResult {
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


type LineRangeReplaceCall = Extract<ToolCall, { name: "replace_in_file" }> & {
  args: { path: string; startLine: number; endLine: number; content: string };
};
export function isReadOnlyToolResult(result: ToolResult): boolean {
  return ["read_file", "view_file", "list_directory", "grep_search", "skim_file", "inspect_env", "web_search", "web_fetch", "get_tool_output"].includes(result.name);
}

function isMutationOrProducerResult(result: ToolResult): boolean {
  if (["write_file", "replace_in_file", "edit_file", "delete_file"].includes(result.name)) return true;
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
    .filter((result) => !result.ok && ["replace_in_file", "edit_file", "write_file"].includes(result.name)).length;
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
    if (result.ok && ["write_file", "replace_in_file", "edit_file", ].includes(result.name) && typeof args.path === "string") {
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
    if (result.name === "read_file") {
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
  if (!result.ok && result.name === "read_file" && typeof args.path === "string" && /no such file|ENOENT/i.test(result.error?.message ?? "")) {
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
  if (call.name === "read_file" || call.name === "view_file" || call.name === "file_view" || call.name === "file_scroll" || call.name === "list_directory") {
    const args = call.args as { path?: unknown; direction?: unknown; lines?: unknown; start_line?: unknown; window?: unknown };
    if (typeof args.path !== "string") return undefined;
    return `${call.name}:${JSON.stringify({ path: args.path, direction: args.direction, lines: args.lines, start_line: args.start_line, window: args.window })}`;
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
  if (result.name === "read_file" || result.name === "view_file" || result.name === "file_view" || result.name === "file_scroll" || result.name === "list_directory") {
    const args = result.args && typeof result.args === "object" ? (result.args as { path?: unknown; direction?: unknown; lines?: unknown; start_line?: unknown; window?: unknown }) : {};
    if (typeof args.path !== "string") return undefined;
    return `${result.name}:${JSON.stringify({ path: args.path, direction: args.direction, lines: args.lines, start_line: args.start_line, window: args.window })}`;
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
  if (result.name === "replace_in_file") {
    if (typeof args.oldString !== "string") return undefined;
    return `${result.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "oldString"].includes(key))))}`;
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
  if (result.name !== "read_file" && result.name !== "view_file" && result.name !== "list_directory" && result.name !== "grep_search") return false;
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
export function classifyMainAgentTransportError(error: unknown):
  | { code: "main_agent_transport_error"; message: string; details: string[] }
  | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
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
  const retryClass = status === 429 || lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("too many requests")
    ? "rate_limit"
    : "transport";
  return {
    code: "main_agent_transport_error",
    message: `Main-agent model call failed with a ${retryClass} transport error. This is infrastructure/provider backpressure, not a malformed agent response; retry the model call without consuming completion-gate attempts. Original error: ${message}`,
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
export async function streamMainAgentResponseWithTransportRetry(
  modelGateway: ModelGateway,
  request: GenerateRequest,
  trajectoryLogger: TrajectoryLogger,
  ctxHooks?: { onProviderTokenLimitError?: (p: { messages: unknown[]; softCap: number; runId?: string }) => Promise<{ messages: unknown[]; savedChars: number }> },
  softCap?: number,
  runId?: string,
  streamCallbacks?: Parameters<typeof streamMainAgentResponse>[2],
): Promise<Awaited<ReturnType<typeof streamMainAgentResponse>>> {
  const backoffsMs = [0, 1_000, 3_000, 9_000];
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
  const friendlyMessage =
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
      content: friendlyMessage,
    });
  } catch {
    // Trajectory is best-effort; never let it block the live loop.
  }
  return {
    content: friendlyMessage,
    finishReason: "stop" as const,
    toolCalls: [],
    role: "assistant" as const,
    provider: "reaper-fallback",
    model: "transport-fallback",
    raw: { transportFallback: true },
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
    if (!result.ok || !["write_file", "replace_in_file", "edit_file", ].includes(result.name)) return false;
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
  return ["read_file", "view_file", "list_directory", "grep_search", "skim_file", "inspect_environment"].includes(result.name);
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
function buildCockpitInput(input: {
  contentPrep: ContentPrepResult;
  runtimeFacts: {
    activeWorkspaceRoot: string;
    latestVerificationFailure?: string;
  };
}): CockpitInput {
  const { contentPrep } = input;
  const trustedSkills = contentPrep.resourceTrust.trusted
    ? contentPrep.skills
    : [];
  return {
    preparedContext: contentPrep.preparedContext,
    contextFiles: contentPrep.contextFiles,
    skills: contentPrep.skills,
    trustedSkills,
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
 * content. write_file/bash/read_file results all collapse to a
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

  // read_file: just the path + line range + truncated marker. The model can re-read.
  if (result.name === "read_file") {
    const path = typeof output.path === "string" ? output.path : typeof args.path === "string" ? args.path : "";
    return {
      ...base,
      ...(path ? { path } : {}),
      ...(typeof output.startLine === "number" ? { startLine: output.startLine } : {}),
      ...(typeof output.endLine === "number" ? { endLine: output.endLine } : {}),
      ...(typeof output.totalLines === "number" ? { totalLines: output.totalLines } : {}),
      ...(output.truncated ? { truncated: true } : {}),
      output: `read_file ${path} (lines ${output.startLine ?? "?"}-${output.endLine ?? "?"} of ${output.totalLines ?? "?"}) — content omitted to save context; re-read with grep_search or read_file when needed.`,
    };
  }

  // write_file / replace_in_file: just the path + ok/error. Successful writes don't need to be re-shown.
  if (result.name === "write_file" || result.name === "replace_in_file" || result.name === "edit_file") {
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
      .filter((result) => ["write_file", "replace_in_file", "edit_file", "delete_file"].includes(result.name))
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
      .filter((result) => ["write_file", "replace_in_file", "edit_file", "delete_file"].includes(result.name))
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
  const runDir = path.join(getReaperScratchpadPaths(workspaceRoot).runs, runId);
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
    if (result.name === "read_file" && isLargeToolOutput(result)) {
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
  return rendered.length > 4500 || (result.name === "read_file" && rendered.split(/\r?\n/).length > 120);
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
export function renderToolCallContract(runId?: string): string {
  // Determine which tools get full-schema rendering
  const discovered = runId ? getDiscoveredTools(runId) : new Set<string>();
  const fullSchemaTools = new Set([...CORE_TOOL_NAMES, ...discovered]);

  // Build the deferred tool list (tools not yet discovered)
  const deferredTools: Array<{ name: string; description: string }> = [];
  for (const [name, spec] of Object.entries(toolRegistry)) {
    if (!fullSchemaTools.has(name)) {
      deferredTools.push({ name, description: spec.description });
    }
  }

  const lines = [
    "# Required Tool Call Format",
    "Every tool call MUST be exactly: {\"id\":\"stable-id\",\"name\":\"tool_name\",\"args\":{...}}.",
    "Do NOT use OpenAI wrappers such as {\"type\":\"function\",\"function\":{\"name\":\"...\",\"arguments\":{...}}}.",
    "Do NOT invent tool names. Unsupported examples: install_dependencies, create_directory, mkdir, read, write, replace, shell.",
    "Use bash for installs, mkdir, scaffolding, tests, builds, and other shell-only operations.",
    "Do not create, edit, delete, chmod, copy, or redirect output into external verifier-owned absolute paths such as /tests or /test. Treat those harness files as read-only and satisfy their contract from workspace files.",
    "Use argument names exactly as shown in the offered tool schema. Do not invent aliases or nested file objects.",
    "Every bash call requires args.cmd and args.timeout in seconds. Add args.description when its purpose is not obvious.",
    "Final verification must be command-backed and strict: tests, build/check commands, diff/cmp/grep -q/jq -e/test assertions, or python/node assertions. Plain ls/cat/curl, version probes, producer scripts, echo success, and print-only checks do not prove completion.",
    "When checking an expected value, hash, count, schema, or exact content, encode the expectation in the command and exit nonzero on mismatch. Printing observed values for the model to compare is inspection, not verification.",
    "",
    "Available tools and exact argument shapes:",
    "- read_file: {\"id\":\"read-1\",\"name\":\"read_file\",\"args\":{\"path\":\"server/app.js\"}}",
    "- view_file: {\"id\":\"view-1\",\"name\":\"view_file\",\"args\":{\"path\":\"server/app.js\",\"startLine\":20,\"endLine\":60}}",
    "- list_directory: {\"id\":\"list-1\",\"name\":\"list_directory\",\"args\":{\"path\":\"server\"}}",
    "- grep_search: {\"id\":\"grep-1\",\"name\":\"grep_search\",\"args\":{\"pattern\":\"TODO\",\"path\":\"src\"}}",
    "- write_file: {\"id\":\"write-1\",\"name\":\"write_file\",\"args\":{\"path\":\"src/file.js\",\"content\":\"full file content\"}}",
    "- replace_in_file exact: {\"id\":\"edit-1\",\"name\":\"replace_in_file\",\"args\":{\"path\":\"src/file.js\",\"oldString\":\"old exact text\",\"newString\":\"new exact text\"}}",
    "- replace_in_file line range: {\"id\":\"edit-2\",\"name\":\"replace_in_file\",\"args\":{\"path\":\"src/file.js\",\"startLine\":10,\"endLine\":14,\"content\":\"replacement text\"}}",
    "- edit_file: {\"id\":\"multi-edit-1\",\"name\":\"edit_file\",\"args\":{\"path\":\"src/file.js\",\"edits\":[{\"oldString\":\"old exact text\",\"newString\":\"new exact text\"}]}}",
    "- delete_file: {\"id\":\"delete-1\",\"name\":\"delete_file\",\"args\":{\"path\":\"tmp/file.txt\"}}",
    "- bash: {\"id\":\"shell-1\",\"name\":\"bash\",\"args\":{\"cmd\":\"npm install\",\"description\":\"install declared project dependencies\",\"timeout\":300}}",
    "- bash background server: {\"id\":\"server-1\",\"name\":\"bash\",\"args\":{\"cmd\":\"npm run dev\",\"description\":\"start app server for runtime check\",\"timeout\":300,\"run_in_background\":true}}",
  ];


  // Conditionally render non-core tool examples only when discovered
  if (fullSchemaTools.has("read_background_output")) {
    lines.push("- read_background_output: {\"id\":\"read-bg-1\",\"name\":\"read_background_output\",\"args\":{\"pid\":123,\"lines\":80}}");
  }
  if (fullSchemaTools.has("signal_process")) {
    lines.push("- signal_process: {\"id\":\"stop-1\",\"name\":\"signal_process\",\"args\":{\"pid\":123,\"signal\":\"SIGTERM\"}}");
  }
  if (fullSchemaTools.has("web_search")) {
    lines.push("- web_search: {\"id\":\"web-1\",\"name\":\"web_search\",\"args\":{\"query\":\"current package documentation\",\"engine\":\"auto\",\"maxResults\":10}}");
  }
  if (fullSchemaTools.has("web_fetch")) {
    lines.push("- web_fetch: {\"id\":\"fetch-1\",\"name\":\"web_fetch\",\"args\":{\"url\":\"https://example.com/docs\",\"extractText\":true}}");
  }

  lines.push(
    "- advance_step: {\"id\":\"advance-1\",\"name\":\"advance_step\",\"args\":{\"summary\":\"what was completed\",\"evidence\":[\"specific evidence\"]}}",
    "- search_tools keyword: {\"id\":\"search-1\",\"name\":\"search_tools\",\"args\":{\"query\":\"background process\"}}",
    "- search_tools direct select: {\"id\":\"search-2\",\"name\":\"search_tools\",\"args\":{\"query\":\"select:read_background_output,signal_process\"}}",
    "To finish the run, return a concise final assistant_message with no tool_calls.",
    "Executor rule: implementation, repair, review, and testing remain on the main model path.",
  );

  // Deferred tools section
  if (deferredTools.length > 0) {
    lines.push(
      "",
      "Additional tools available via search_tools (call search_tools with a keyword to unlock full schema):",
      ...deferredTools.map((t) => `  - ${t.name}: ${t.description.slice(0, 80)}`),
    );
  }

  lines.push(
    "",
    "Common conversions:",
    "- To create a directory, use bash with {\"cmd\":\"mkdir -p path/to/dir\",\"timeout\":60}.",
    "- To install dependencies, use bash with the real package-manager command for the active ecosystem, for example {\"cmd\":\"npm install express\",\"timeout\":300} only in a JavaScript/Node project.",
    "- To run create-vite or another scaffold non-interactively, include documented non-interactive flags or create files directly with write_file.",
    "",
    "Build/config path discipline:",
    "- If a build tool says a source/config file is missing, list/read the owning build config and the exact referenced path before rerunning the build.",
    "- Fix source/config path mismatches by either creating the file at the path referenced by the build config or updating the build config to the actual file path. Do not keep building from a directory that lacks the required config.",
    "- If a command fails because it was run from the wrong directory, rerun from the directory containing the relevant manifest/build config, or pass the build tool's explicit source/build directory flags.",
    "- If recent tool results include workspacePathAliases, treat those as equivalent roots. When writing scripts/configs that run through bash, embed the runtime/container path or a relative path, not the host scratch path.",
    "- After a failed build/test/runtime command, continue with concrete repair or check tool calls unless a later command has passed and the requested work is complete.",
  );

  return lines.join("\n");
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
  if (["read_background_output", "signal_process", "write_to_process"].includes(String(name)) && typeof args.pid === "number" && args.pid <= 0) {
    args.pid = 1;
  }
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
  if (name === "replace_in_file") {
    normalizeStringAlias(args, "oldString", ["old", "old_string", "old_str", "oldText", "old_text", "search", "find"]);
    normalizeStringAlias(args, "newString", ["new", "new_string", "new_str", "newText", "new_text", "replacement", "replace"]);
    normalizeNumberAlias(args, "startLine", ["start_line", "lineStart", "line_start"]);
    normalizeNumberAlias(args, "endLine", ["end_line", "lineEnd", "line_end"]);
    normalizeStringAlias(args, "content", ["contents", "body", "text", "data", "source"]);
    if (typeof args.startLine === "number" && typeof args.endLine === "number" && typeof args.content !== "string" && typeof args.newString === "string") {
      args.content = args.newString;
    }
    if (typeof args.startLine === "number" && typeof args.endLine === "number" && typeof args.content === "string") {
      delete args.oldString;
      delete args.newString;
    }
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
    name = "read_file";
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
    read: "read_file",
    readfile: "read_file",
    list: "list_directory",
    ls: "list_directory",
    grep: "grep_search",
    search: "grep_search",
    write: "write_file",
    write_to_file: "write_file",
    writefile: "write_file",
    edit: "replace_in_file",
    replace: "replace_in_file",
    delete: "delete_file",
    rm: "delete_file",
    advance: "advance_step",
    replace_in_file_line_range: "replace_in_file",
    replace_in_file_exact: "replace_in_file",
    edit_file_line_range: "replace_in_file",
    line_range_replace: "replace_in_file",
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
  if (Number.isInteger(parsed) && parsed >= 100) {
    return parsed;
  }
  return 8000;
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
