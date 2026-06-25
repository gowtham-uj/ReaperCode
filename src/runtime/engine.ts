import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { parseReaperConfig, type ReaperConfig } from "../config/model-config.js";
import {
  buildProblemContractText, buildRecentDiagnosticText, describeToolResultTarget,
  guardRelevanceGatedActions, isProjectConfigPath, buildRelevanceGateFeedback, classifyActionRelevance, classifyShellCommandRelevance, isGeneratedBuildCleanupCommand, isRequiredSourceAcquisitionCommand, extractGitCloneTarget, extractGitCloneUrl, stripShellToken,
  classifyMutationRelevance, getMutationLiteralText, findVerifierOnlyExpectedLiteralInResults, extractExpectedOracleLiteralsFromResults, isVerifierOrTestFailureText, hasTrustedLiteralEvidenceBefore, getToolResultVisibleOutput, renderUnknownValue, normalizeLiteralEvidence, extractExpectedOracleLiterals,
  isLikelyFinalOutputPath, isTaskFacingDeliverableMutation, isDeliverableFilePath, pathTokensForRelevance, tokenMatchesProblemText, isTemporaryValidationSourcePath, renderStepText, isInstallOrUpgradeCommand, isLintFormatCleanupCommand, isFrameworkMigrationCommand,
  isLintOrFormattingConfigPath, isDependencyManifestPath, isSourceLikePath, extractRmTargets, getToolResultCommand, isBuildCommand, isTestCommand, normalizePlanStepText, textSimilarity, normalizeVerificationCommand,
  isVerificationLikeCommand, hasInlineAssertionOrFailureExit, shellCommandDirectlyWritesLiteral,
  persistExecutionPlanProgress
} from "./relevance-gate.js";

import {
  inferTransport, extractIntentSummary, makeEvent, splitControlToolCalls,
  persistRunResult, logAssistantMessageTrace, logModelResponseTrace,
} from "./runtime-state.js";
import { renderToolResultForModel, summarizeToolResult } from "../context/history-compaction.js";
import { executeToolCalls } from "../execution/scheduler.js";
import {
  parseAgentRequestEnvelope,
  type AgentEventEnvelope,
  type AgentRequestEnvelope,
  type TransportKind,
} from "../connection/schemas.js";
import { classifyToolCall } from "../execution/planner.js";
import { AuditLogger } from "../logging/audit.js";
import { logLangfuseEvent } from "../logging/langfuse.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import { generateStructuredJson } from "../model/json-response.js";
import type { ModelGateway, ModelRole, ResolvedModelProfile } from "../model/types.js";
import { pushModelCallContext } from "../model/observability.js";
import { appendFailureMemory, loadRecentFailureMemory } from "../recovery/failure-memory.js";
import { commitVerifiedRunKnowledge, loadVerifiedLessons } from "../recovery/verified-memory.js";
import { RecoverySession } from "../recovery/session.js";
import {ToolExecutor} from "../tools/executor.js";
import type {AuthoringToolDeps, ShellRunner} from "../tools/executor.js";
import type {Hooks} from "../adaptive/hooks.js";
import {SubagentPool} from "./subagent-pool.js";
import {
  extractFilePathsFromFailure,
  inferFilesHintFromResults,
  isGeneratedOrBuildPath,
  normalizeArtifactPathForMatch,
  stripWorkspacePrefix,
  uniqueStrings,
} from "./file-hints.js";
import {
  createTask as createSessionTask,
  listTasks as listSessionTasks,
  updateTask as updateSessionTask,
  clearTasks as clearSessionTasks,
} from "../tools/write/task.js";
import { getDiscoveredTools, discoverTools, clearDiscoveredTools } from "../tools/discovery.js";
import { toolRegistry, CORE_TOOL_NAMES } from "../tools/registry.js";
import { classifyShellCommandSemantics } from "../tools/command-semantics.js";
import { loadMcpServersFromFile } from "../tools/mcp/config.js";
import { MergedToolRegistry } from "../tools/mcp/registry.js";
import { ToolCallSchema, type ToolCall, type ToolResult } from "../tools/types.js";
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
import { inspectProject, renderRepoInspectionForCockpit, type RepoInspection } from "./repo-inspection.js";
import type { MiddlewareDefinition } from "./middleware.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { createReaperRunContext, ensureReaperRunContext, writeLatestRunPointer, type ReaperRunContext } from "./run-manager.js";
import { renderFingerprintForPrompt } from "./fingerprint.js";
import { registerCleanup, runCleanupFunctions, setActiveRunDir, installCrashHandlers } from "./cleanup-registry.js";
import {
  detectAlternatingNoProgressPattern,
  evaluateStepBudget,
  guardNoProgressToolCalls,
  reuseCachedSuccessfulActions,
  makeToolResultActionSignature as makeProgressToolResultActionSignature,
  makeToolResultObservationSignature,
} from "./progress-guard.js";
import { buildDerivedSecretEncodingFeedback } from "./derived-secret-encoding.js";
import { enforcePatcherStatusIntegrity } from "./status-integrity.js";
import { buildSessionMetricsSummary } from "./session-metrics.js";
import { collectWorkspaceDiff, runFreshContextDiffReview } from "../verify/diff-review.js";
import { getContractCoverageBlocker, renderContractCoverageMatrix } from "../verify/contract-coverage.js";
import { getArtifactObligationBlocker, renderArtifactObligationLedger } from "./artifact-obligations.js";
import { buildRescueHypothesisLedger, renderRescueHypothesisLedger } from "./hypothesis-ledger.js";
import { callMainAgent } from "./main-agent-node.js";
import { buildMainAgentCockpit, buildMainAgentSystemPrompt } from "./main-agent-prompt.js";
import { validateToolCallBatch, type ToolValidationBlocker } from "./tool-validation.js";
import { validateStrictCompletion, type CompletionValidationBlocker } from "./completion-validation.js";
import { extractTaskContract, renderTaskContractForCockpit, type TaskContract } from "./task-contract.js";
import {
  addTodoItem,
  applyCandidatePlan,
  createPlanState,
  createTodoState,
  planProgress,
  renderPlanForCockpit,
  renderTodoForCockpit,
  setPlanSteps,
  updateTodoItem,
  type PlanState,
  type TodoState,
} from "./plan-state.js";
import {
  createVerificationState,
  ingestReviewerVerdicts,
  isReviewerBlocking,
  recordVerificationCheck,
  renderVerificationStateForCockpit,
  type VerificationState,
} from "./verification-state.js";
import {
  createRescueWatchdogState,
  evaluateRescueWatchdog,
  isNoDiagnosticShellExitFailure,
  type RescueWatchdogState,
  type RuntimeBlockingFacts,
} from "./rescue-watchdog.js";

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

export interface SplitToolCalls {
  executableToolCalls: ToolCall[];
  advisoryToolCalls?: Array<Extract<ToolCall, { name: "update_plan" | "update_todo" }>>;
  completionSignal?: Extract<ToolCall, { name: "complete_task" }>;
  advancementSignal?: Extract<ToolCall, { name: "advance_step" }>;
}

function buildGeneralAgentTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  // The main agent's tool surface is a curated, always-on set. It is large
  // enough to support Codex-style workflows (search, edit, verify, plan) but
  // small enough to keep prompt tokens bounded. The full tool registry stays
  // discoverable via search_tools when the model needs rare capabilities.
  return [
    {
      name: "read_file",
      description: "Read a text file from the workspace by relative path. Returns the file contents (or a window).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "grep_search",
      description: "Search for a regex pattern across workspace files. Returns matching lines with file paths and line numbers.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          maxResults: { type: "number" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "list_directory",
      description: "List entries under a workspace directory (non-recursive).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          includeHidden: { type: "boolean" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description: "Create or fully overwrite a text file in the workspace. Prefer replace_in_file for targeted edits.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "replace_in_file",
      description: "Replace an exact string in a workspace file. Use for targeted edits; prefer this over write_file when possible.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_file",
      description: "Delete a workspace file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "run_shell_command",
      description: "Run a shell command in the workspace, usually for tests, verification, or repo introspection. Outputs above 8KB are spillovered to .reaper/spillover; use get_tool_output to retrieve.",
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          timeoutMs: { type: "number" },
          isBackground: { type: "boolean" },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
    {
      name: "git_status",
      description: "Inspect current git status (modified, added, deleted files).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "git_diff",
      description: "Show uncommitted changes. With staged:true shows staged diff, with path filter restricts to a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          staged: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "create_checkpoint",
      description: "Snapshot the current workspace into a checkpoint. Use before risky changes so you can restore if the change breaks things.",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "restore_checkpoint",
      description: "Restore the workspace to a previously created checkpoint.",
      inputSchema: {
        type: "object",
        properties: { checkpointId: { type: "string" } },
        required: ["checkpointId"],
        additionalProperties: false,
      },
    },
    {
      name: "web_search",
      description: "Search the web for a query. Use for documentation lookups, version-specific answers, and external references.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "update_plan",
      description: "Persist or update the agent's working plan. Use to record multi-step intent before acting, and to mark steps as in_progress/completed as work progresses.",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "string" },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
    {
      name: "update_todo",
      description: "Update the todo list (status, priority, evidence). Use to keep a durable working memory across turns.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
                priority: { type: "string", enum: ["low", "medium", "high"] },
                evidence: { type: "string" },
              },
              required: ["id", "content", "status"],
            },
          },
          append: { type: "boolean" },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
    {
      name: "call_subagent",
      description: "Delegate a focused, read-only investigation to a subagent (codebase exploration, doc lookup, dependency research). The subagent returns a structured result; you stay in control.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    {
      name: "search_tools",
      description: "Discover additional tools beyond the always-on set. Use when none of the always-on tools fit the next step (e.g. browser control, human approval, MCP tools).",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_tool_output",
      description: "Retrieve a previously spillovered tool result by artifact id. Use after run_shell_command returns a spillover handle. Supports startLine/endLine, regex pattern, jsonPath, and maxBytes to inspect large outputs without re-pasting.",
      inputSchema: {
        type: "object",
        properties: {
          artifactId: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          pattern: { type: "string" },
          jsonPath: { type: "string" },
          maxBytes: { type: "number" },
        },
        required: ["artifactId"],
        additionalProperties: false,
      },
    },
    {
      name: "complete_task",
      description: "Mark the task complete after implementation and verification evidence. Use this immediately after relevant tests/verification pass.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  ];
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
  agent?: "executor" | "reviewer" | "tester" | "researcher";
  tool_calls: ToolCall[];
}

export type PlannerStepType = NonNullable<ExecutionPlanStep["type"]>;

export interface PlannerSubagentPlan {
  installs: Array<{ manager: string; packages: string[]; reason: string }>;
  steps: ExecutionPlanStep[];
  testGuidance: string;
}

export interface PatcherSubagentResult {
  taskId: string;
  status: "patched_and_verified" | "patched_but_not_fully_verified" | "needs_parent_decision" | "failed_to_patch" | "patch_in_progress";
  summary: string;
  filesChanged: string[];
  behaviorChanged: string[];
  testsRun: Array<{ command: string; result: "passed" | "failed" | "skipped"; importantOutput?: string }>;
  remainingRisks: string[];
  parentNeedsToKnow: string[];
  tool_calls: ToolCall[];
  diff?: string;
}

interface StuckDetectionState {
  toolFailureSignatures: string[];
  lowInformationActionSignatures: string[];
  verificationFailureSignatures: string[];
  processedToolCallIds: string[];
  actionObservationSignatures: string[];
  noActionTurns: number;
  tripped: boolean;
  repeatedCount: number;
  reason?: string;
}

interface RuntimeDeadlinePressure {
  active: boolean;
  critical: boolean;
  elapsedMs: number;
  deadlineMs?: number;
  remainingMs?: number;
  feedback?: string;
  negativeConstraint?: string;
}

type GraphMode = "explicit_tools" | "needs_model" | "autonomous";
type OrchestrationMode = "simple_executor" | "complex_orchestrator";

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
  repoInspection?: RepoInspection;
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
  patchingStepIndex: number | null;
  patchAttemptsByStep: Record<string, number>;
  patcherInvocationCount: number;
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
  stuckDetection: StuckDetectionState;
  stuckReplanCount: number;
  readOnlyBatchSignatures: string[];
  needsReplan: boolean;
  done: boolean;
  /** Structured advisory results from background subagents that have completed since the last turn. */
  backgroundSubagentResults?: BackgroundSubagentResult[];
};

const ReaperGraphState = Annotation.Root({
  request: Annotation<AgentRequestEnvelope | undefined>(),
  boot: Annotation<Phase0BootstrapResult | undefined>(),
  prompt: Annotation<string>(),
  mode: Annotation<GraphMode | undefined>(),
  orchestrationMode: Annotation<OrchestrationMode | undefined>(),
  repoInspection: Annotation<RepoInspection | undefined>(),
  taskContract: Annotation<TaskContract | undefined>(),
  planState: Annotation<PlanState>({
    reducer: (_left, right) => right,
    default: () => createPlanState(),
  }),
  todoState: Annotation<TodoState>({
    reducer: (_left, right) => right,
    default: () => createTodoState(),
  }),
  verificationState: Annotation<VerificationState | undefined>(),
  runtimeBlockers: Annotation<RuntimeBlocker[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  shouldCompact: Annotation<boolean>(),
  contentPrep: Annotation<ContentPrepResult | undefined>(),
  executionPlan: Annotation<ExecutionPlanStep[] | undefined>(),
  currentStepIndex: Annotation<number>(),
  currentStepToolStartIndex: Annotation<number>(),
  completedStepIds: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  patchingStepIndex: Annotation<number | null>(),
  patchAttemptsByStep: Annotation<Record<string, number>>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),
  patcherInvocationCount: Annotation<number>(),
  rescueWatchdog: Annotation<RescueWatchdogState>({
    reducer: (_left, right) => right,
    default: () => createRescueWatchdogState(),
  }),
  plannedToolCalls: Annotation<ToolCall[] | undefined>(),
  split: Annotation<SplitToolCalls | undefined>(),
  toolResults: Annotation<ToolResult[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  events: Annotation<AgentEventEnvelope[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  assistantMessage: Annotation<string>(),
  explicitVerification: Annotation<RuntimeEngineResult["verification"] | undefined>(),
  feedback: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  negativeConstraints: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  contentFingerprint: Annotation<string | undefined>(),
  iteration: Annotation<number>(),
  lastBatchFailed: Annotation<boolean>(),
  completionGateAttempts: Annotation<number>(),
  completionGateExhausted: Annotation<boolean>(),
  stuckDetection: Annotation<StuckDetectionState>({
    reducer: (_left, right) => right,
    default: () => createStuckDetectionState(),
  }),
  stuckReplanCount: Annotation<number>(),
  readOnlyBatchSignatures: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  needsReplan: Annotation<boolean>(),
  done: Annotation<boolean>(),
  backgroundSubagentResults: Annotation<BackgroundSubagentResult[] | undefined>(),
});

type ModelRouteName = keyof ReaperConfig["modelRouting"];

type BackgroundSubagentResult = {
  jobId: string;
  type: string;
  status: string;
  result?: unknown;
  error?: string;
  stale: boolean;
  staleReason?: string;
};

async function injectBackgroundSubagentResults(
  _state: GraphState,
  pool: SubagentPool,
): Promise<{ results: BackgroundSubagentResult[]; blockers: RuntimeBlocker[] }> {
  const completed = pool.flushCompleted();
  const results: BackgroundSubagentResult[] = [];
  const blockers: RuntimeBlocker[] = [];

  for (const job of completed) {
    if (job.injected) continue;
    job.injected = true;

    let stale = false;
    let staleReason: string | undefined;
    try {
      const snapshot = await computeFileSnapshot(job.observedFiles ?? []);
      if (job.baseFilesSnapshot && snapshot !== job.baseFilesSnapshot) {
        stale = true;
        staleReason = `Observed files changed since subagent '${job.id}' started; result may be stale.`;
      }
    } catch {
      // If we cannot read the files, treat as stale as a conservative default.
      stale = true;
      staleReason = `Unable to verify observed files for subagent '${job.id}'; result treated as stale.`;
    }
    results.push({
      jobId: job.id,
      type: job.type,
      status: job.status,
      stale,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(staleReason !== undefined ? { staleReason } : {}),
    });
    if (stale) {
      blockers.push({
        source: "runtime",
        code: "subagent_result_stale",
        message: staleReason ?? "Subagent result is stale.",
        ...(staleReason !== undefined ? { details: [staleReason] } : {}),
      });
    }
  }

  return { results, blockers };
}

async function computeFileSnapshot(filePaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  const sorted = [...filePaths].sort();
  for (const filePath of sorted) {
    try {
      const content = await readFile(filePath);
      hash.update(content);
    } catch {
      hash.update(`__missing__${filePath}`);
    }
  }
  if (sorted.length === 0) {
    hash.update("__empty__");
  }
  return hash.digest("hex");
}

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

function runtimeBlockerFromCompletionValidation(blocker: CompletionValidationBlocker): RuntimeBlocker {
  return {
    source: "completion_validation",
    code: blocker.code,
    message: blocker.message,
    ...(blocker.details?.length ? { details: blocker.details } : {}),
  };
}

function buildSystemPromptForRole(role: string): string {
  const base = "You are a Reaper sub-agent. Emit only valid tool-call JSON. Do not invent tools.";
  if (role === "repair") return `${base} Focus on the smallest concrete fix and validate it.`;
  if (role === "recovery") return `${base} Collapse complexity to the externally visible contract.`;
  return base;
}

function isPlanStepType(value: unknown): value is PlannerStepType {
  return typeof value === "string" && ["command", "review", "inspect", "test", "verify", "finalize"].includes(value);
}

function isPlanStepOnFailure(value: unknown): value is NonNullable<ExecutionPlanStep["onFailure"]> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export class RuntimeEngine {
  private readonly config: ReaperConfig;
  private trajectoryLogger: TrajectoryLogger;

  constructor(private readonly input: RuntimeEngineInput) {
    this.config = parseReaperConfig(input.config);
    this.trajectoryLogger = new TrajectoryLogger(input.workspaceRoot, this.config.logging);
  }

  static shouldHandle(input: RuntimeEngineInput): boolean {
    const request = parseAgentRequestEnvelope(input.requestEnvelope);
    const hasExplicitToolCalls = Array.isArray(request.payload.tool_calls) && request.payload.tool_calls.length > 0;
    return hasExplicitToolCalls || !input.modelGateway || Boolean(input.modelGateway);
  }

  async run(): Promise<RuntimeEngineResult> {
    const startedAt = Date.now();
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
    // once per run so all sub-agent calls (planner, patcher, executor, repair,
    // recovery) share the same cacheable prefix. Anthropic/OpenRouter/Codex
    // use the literal prefix bytes as the cache key.
    const systemPromptPrefix = buildSystemPromptForRole("executor");
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
      return await this.runInner({ startedAt, initialRequest, runContext });
    } finally {
      releaseModelCallContext();
    }
  }

  private async runInner(params: {
    startedAt: number;
    initialRequest: AgentRequestEnvelope;
    runContext: ReturnType<typeof createReaperRunContext>;
  }): Promise<RuntimeEngineResult> {
    const { initialRequest, runContext } = params;
    const startedAt = params.startedAt;

    let request: AgentRequestEnvelope | undefined;
    let boot: Phase0BootstrapResult | undefined;
    let recoverySession: RecoverySession | undefined;
    let executor: ToolExecutor | undefined;
    let auditLogger: AuditLogger | undefined;
    let mcpRegistry: MergedToolRegistry | undefined;
    let subagentPool: SubagentPool | undefined;

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
      const repoInspection = await inspectProject(this.input.workspaceRoot).catch(() => undefined);

      boot = bootPhase0Runtime({
        config: this.config,
        transport: inferTransport(request.metadata.transport),
        requestEnvelope: request,
        userIntentSummary: extractIntentSummary(request),
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        traceId: runContext.traceId,
        ...(repoInspection ? { repoInspection } : {}),
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
        const serverConfigs = [...(this.config.mcp.servers ?? []), ...loadMcpServersFromFile(this.input.workspaceRoot)];
        for (const serverConfig of serverConfigs) {
          await mcpRegistry.addMcpServer(serverConfig).catch((error) => {
            console.warn(`[runtime-engine] MCP server '${serverConfig.name}' failed to load:`, error);
          });
        }
      }
      if (this.input.modelGateway) {
        subagentPool = await SubagentPool.create({
          config: this.config,
          workspaceRoot: this.input.workspaceRoot,
          runDir: runContext.runDir,
        });
      }
      executor = new ToolExecutor({
        workspaceRoot: this.input.workspaceRoot,
        runId: boot.state.runId,
        sessionId: boot.state.sessionId,
        traceId: boot.state.runId,
        logLevel: boot.state.logLevel,
        safetyProfile: boot.state.safetyProfile,
        permissionMode: (process.env.REAPER_PERMISSION_MODE as any) ?? "yolo",
        recoverySession,
        config: this.config,
        ...(this.input.modelGateway ? { modelGateway: this.input.modelGateway } : {}),
        subagentPool,
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
        ...(repoInspection ? { repoInspection } : {}),
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
        patchingStepIndex: null,
        patchAttemptsByStep: {},
        patcherInvocationCount: 0,
        rescueWatchdog: createRescueWatchdogState(),
        lastBatchFailed: false,
        completionGateAttempts: 0,
        completionGateExhausted: false,
        shouldCompact: false,
        stuckDetection: createStuckDetectionState(),
        stuckReplanCount: 0,
        readOnlyBatchSignatures: [],
        needsReplan: false,
        done: false,
      } satisfies Partial<GraphState>;
    };

    const inspectProjectNode = async (state: GraphState) => {
      const repoInspection = state.repoInspection ?? getBoot().state.repoInspection;
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
        to_step: "Inspect Project",
      });
      return repoInspection ? { repoInspection } satisfies Partial<GraphState> : {};
    };

    const extractTaskContractNode = async (state: GraphState) => {
      const taskContract = extractTaskContract(state.prompt, state.repoInspection);
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
        from_step: "Inspect Project",
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
        prompt: state.prompt,
        maxContextTokens: Math.max(2000, Math.floor(getBoot().state.tokenBudget.softCap * 0.1)),
        compactToolResults: prePrepShouldCompact,
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
      if (subagentPool) {
        const injection = await injectBackgroundSubagentResults(state, subagentPool);
        if (injection.results.length) {
          state.backgroundSubagentResults = injection.results;
        }
        if (injection.blockers.length) {
          state.runtimeBlockers = [...state.runtimeBlockers, ...injection.blockers];
        }
      }

      if (!this.input.modelGateway || !state.contentPrep) return {};

      let mutableState: GraphState = state;
      if (mutableState.verificationState) {
        const nextVerificationState = ingestReviewerVerdicts(mutableState.verificationState, mutableState.toolResults);
        if (nextVerificationState !== mutableState.verificationState) {
          mutableState = { ...mutableState, verificationState: nextVerificationState };
        }
      }
      state = mutableState;

      const system = buildMainAgentSystemPrompt(state);
      const generalAgentTools = buildGeneralAgentTools();
      const cockpit = buildMainAgentCockpit(
        {
          ...state,
          repoInspection: state.repoInspection,
          taskContract: state.taskContract,
          currentPlan: renderPlanForCockpit(state.planState),
          todo: renderTodoForCockpit(state.todoState),
          verificationState: state.verificationState,
          runtimeBlockers: state.runtimeBlockers,
          recentToolResults: state.toolResults,
          feedback: state.feedback,
          negativeConstraints: state.negativeConstraints,
          // Wire the content-prep output (Repo Snapshot, Tool Shortlist, Skills,
          // Mentions, Prepared Context chunks) so the model actually sees the
          // output of the expensive prep pipeline that runs in contentPrepNode.
          contentPrep: state.contentPrep,
        },
        getRequest(),
        state.taskContract ? renderTaskContractForCockpit(state.taskContract) : undefined,
        state.repoInspection ? renderRepoInspectionForCockpit(state.repoInspection) : undefined,
        state.verificationState ? renderVerificationStateForCockpit(state.verificationState) : undefined,
        {
          iteration: state.iteration,
          tokenBudget: getBoot().state.tokenBudget,
          completionGateAttempts: state.completionGateAttempts,
          runtimeDeadline: getRuntimeDeadlinePressure(startedAt),
        },
        {
          workspaceRoot: this.input.workspaceRoot,
          availableTools: generalAgentTools,
        },
      );

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
        const result = await callMainAgent({
          modelGateway: this.input.modelGateway,
          role: modelRoute(this.config, "mainAgent"),
          system,
          cockpit,
          tools: generalAgentTools,
          maxTokens: 8192,
          ...(this.input.abortSignal ? { abortSignal: this.input.abortSignal } : {}),
        });
        await logModelResponseTrace({
          trajectoryLogger: this.trajectoryLogger,
          runId: getBoot().state.runId,
          sessionId: getBoot().state.sessionId,
          traceId: getBoot().state.runId,
          level: getBoot().state.logLevel,
          source: "main_agent",
          assistantMessage: result.assistantMessage,
          toolCalls: result.toolCalls,
        });
        await logAssistantMessageTrace({
          trajectoryLogger: this.trajectoryLogger,
          runId: getBoot().state.runId,
          sessionId: getBoot().state.sessionId,
          traceId: getBoot().state.runId,
          level: getBoot().state.logLevel,
          source: "main_agent",
          content: result.assistantMessage,
        });
        return {
          plannedToolCalls: result.toolCalls,
          assistantMessage: result.assistantMessage,
          feedback: result.feedback.length ? [...state.feedback, ...result.feedback] : state.feedback,
          runtimeBlockers: result.validationBlockers.length
            ? [
                ...state.runtimeBlockers,
                ...result.validationBlockers.map((blocker) => runtimeBlockerFromToolValidation(blocker)),
              ]
            : state.runtimeBlockers,
          iteration: state.iteration + 1,
        } satisfies Partial<GraphState>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transport = classifyMainAgentTransportError(error);
        await this.trajectoryLogger.write({
          event_id: randomUUID(),
          run_id: getBoot().state.runId,
          session_id: getBoot().state.sessionId,
          trace_id: getBoot().state.runId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: "assistant_message",
          level: getBoot().state.logLevel,
          content: `[${transport ? "main_agent_transport_error" : "main_agent_schema_error"}] ${message}`,
        });
        const blocker: RuntimeBlocker = transport
          ? {
              source: "model",
              code: transport.code,
              message: transport.message,
              details: transport.details,
            }
          : {
              source: "schema",
              code: "main_agent_schema_error",
              message,
            };
        const attempts = transport ? state.completionGateAttempts : state.completionGateAttempts + 1;
        const nextRuntimeBlockers = [...state.runtimeBlockers, blocker];
        const transportRetryExhausted = transport ? countConsecutiveModelTransportBlockers(nextRuntimeBlockers) >= mainAgentTransportRetryLimit() : false;
        return {
          plannedToolCalls: [],
          assistantMessage: transportRetryExhausted
            ? `${transport?.message ?? message}\nMain-agent transport retry budget exhausted; stopping as infrastructure/provider failure instead of looping forever.`
            : message,
          feedback: [
            ...state.feedback,
            transportRetryExhausted
              ? `${transport?.message ?? message}\nMain-agent transport retry budget exhausted; stop rather than consuming completion-gate attempts or executing empty tool batches.`
              : transport?.message ?? message,
          ],
          runtimeBlockers: nextRuntimeBlockers,
          completionGateAttempts: attempts,
          completionGateExhausted: transport ? (state.completionGateExhausted || transportRetryExhausted) : attempts >= this.config.runtime.completionGateMax,
          iteration: state.iteration + 1,
        } satisfies Partial<GraphState>;
      }
    };

    const validateToolCallsNode = async (state: GraphState) => {
      const toolCalls = state.plannedToolCalls ?? [];
      const validation = validateToolCallBatch(toolCalls, {
        agentRole: "main",
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
          completionGateExhausted: attempts >= this.config.runtime.completionGateMax,
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

    const verifyCompletionNode = async (state: GraphState) => {
      const verificationState = state.verificationState
        ? ingestReviewerVerdicts(state.verificationState, state.toolResults)
        : state.verificationState;
      const completion = state.split?.completionSignal;
      const validation = validateStrictCompletion({
        toolCalls: state.plannedToolCalls ?? [],
        ...(completion ? { completionSignal: completion } : {}),
        ...(state.taskContract ? { taskContract: state.taskContract } : {}),
        ...(verificationState ? { verificationState } : {}),
        toolResults: state.toolResults,
        requireVerificationLadder: this.config.verification.requireGroundedCompletion || Boolean(completion?.args.verificationContract?.commands?.length),
      });

      if (validation.ok && verificationState && isReviewerBlocking(verificationState)) {
        const blocker: RuntimeBlocker = {
          source: "completion_validation",
          code: "reviewer_blocked_completion",
          message: "Completion is blocked because a reviewer subagent issued a 'block' verdict. Address the review evidence before calling complete_task.",
        };
        return {
          plannedToolCalls: [],
          runtimeBlockers: [...state.runtimeBlockers, blocker],
          feedback: [...state.feedback, blocker.message],
          completionGateAttempts: state.completionGateAttempts + 1,
          completionGateExhausted: state.completionGateAttempts + 1 >= this.config.runtime.completionGateMax,
        } satisfies Partial<GraphState>;
      }

      if (validation.ok) {
        const runtimeCompletionBlocker = getCompletionBlocker(state.toolResults, getBoot().state.runId, state.prompt, this.config);
        if (runtimeCompletionBlocker) {
          const blocker: RuntimeBlocker = {
            source: "completion_validation",
            code: "runtime_completion_blocker",
            message: runtimeCompletionBlocker,
          };
          const attempts = state.completionGateAttempts + 1;
          const { completionSignal: _completionSignal, ...splitWithoutCompletion } = state.split ?? { executableToolCalls: [] };
          return {
            split: splitWithoutCompletion,
            plannedToolCalls: [],
            runtimeBlockers: [...state.runtimeBlockers, blocker],
            feedback: [
              ...state.feedback,
              runtimeCompletionBlocker,
              "The complete_task signal was rejected because runtime evidence still contains unresolved blockers. Continue with concrete tools, then emit complete_task after new successful evidence.",
            ],
            completionGateAttempts: attempts,
            completionGateExhausted: attempts >= this.config.runtime.completionGateMax,
          } satisfies Partial<GraphState>;
        }
        return {
          runtimeBlockers: [],
          completionGateAttempts: 0,
        } satisfies Partial<GraphState>;
      }

      const blockers = validation.blockers.map((blocker) => runtimeBlockerFromCompletionValidation(blocker));
      const attempts = state.completionGateAttempts + 1;
      const { completionSignal: _completionSignal, ...splitWithoutCompletion } = state.split ?? { executableToolCalls: [] };
      return {
        split: splitWithoutCompletion,
        plannedToolCalls: [],
        runtimeBlockers: [...state.runtimeBlockers, ...blockers],
        feedback: [...state.feedback, ...blockers.map((blocker) => blocker.message)],
        negativeConstraints: [
          ...state.negativeConstraints,
          "Do not emit complete_task again until there is new successful evidence for the task contract and verification ladder.",
        ],
        completionGateAttempts: attempts,
        completionGateExhausted: attempts >= this.config.runtime.completionGateMax,
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

    const simpleExecutorNode = async (state: GraphState) => {
      if (!this.input.modelGateway || !state.contentPrep) return {};
      const activeRuntimeState = getBoot().state;
      const result = await generateStructuredJson({
        modelGateway: this.input.modelGateway,
        source: "executor_subagent",
        role: modelRoute(this.config, "executor"),
        switchModeOnTruncation: true,
        maxTokens: 8192,
        system: buildSystemPromptForRole("executor"),
        messages: [
          {
            role: "user",
              content: buildSimpleExecutorPrompt({
                prompt: state.prompt,
                contentPrep: state.contentPrep,
                ...(activeRuntimeState.repoInspection ? { repoInspection: activeRuntimeState.repoInspection } : {}),
                toolResults: state.toolResults,
                feedback: state.feedback,
                negativeConstraints: state.negativeConstraints,
                blockingFacts: deriveRuntimeBlockingFacts(state.toolResults),
                runId: activeRuntimeState.runId,
              }),
          },
        ],
        parse: (value) => parsePlannedToolCalls(value),
      });
      const rawAssistantMessage = result.assistant_message ?? "";
      await logModelResponseTrace({
        trajectoryLogger: this.trajectoryLogger,
        runId: getBoot().state.runId,
        sessionId: getBoot().state.sessionId,
        traceId: getBoot().state.runId,
        level: getBoot().state.logLevel,
        source: "simple_executor",
        assistantMessage: rawAssistantMessage,
        toolCalls: result.tool_calls,
      });
      await logAssistantMessageTrace({
        trajectoryLogger: this.trajectoryLogger,
        runId: getBoot().state.runId,
        sessionId: getBoot().state.sessionId,
        traceId: getBoot().state.runId,
        level: getBoot().state.logLevel,
        source: "simple_executor",
        content: rawAssistantMessage,
      });
      const assistantMessage = getCompletionSummary(result.tool_calls) ? rawAssistantMessage : "";
      const plannedToolCalls = result.tool_calls;
      const messageEvent = assistantMessage ? [makeEvent(getRequest(), "assistant_message", { content: assistantMessage })] : [];
      return {
        plannedToolCalls,
        assistantMessage,
        feedback:
          result.tool_calls.length === 0 && plannedToolCalls.length === 0
            ? [
                ...state.feedback,
                "The model returned no tool calls. Continue with concrete tools, or explicitly call complete_task with a final summary when the requested task is complete.",
              ]
            : state.feedback,
        events: [...state.events, ...messageEvent],
        iteration: state.iteration + 1,
      } satisfies Partial<GraphState>;
    };

    const categorizeToolsNode = async (state: GraphState) => {
      const activeRequest = getRequest();
      const toolCalls =
        state.mode === "autonomous"
          ? state.plannedToolCalls ?? []
          : (Array.isArray(activeRequest.payload.tool_calls) ? activeRequest.payload.tool_calls : []).map((call) => ToolCallSchema.parse(call));
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
          : (Array.isArray(activeRequest.payload.tool_calls) ? activeRequest.payload.tool_calls : []).map((call) => ToolCallSchema.parse(call));
      const split = splitControlToolCalls(toolCalls);
      const normalizedExecutableToolCalls = normalizeExecutableToolCalls(split.executableToolCalls);
      const automaticServiceRecovery = buildAutomaticServiceRecoveryCall(
        normalizedExecutableToolCalls,
        state.toolResults,
        this.config.runtime.serviceSupervisor,
      );
      const executableToolCalls = automaticServiceRecovery ? [automaticServiceRecovery] : normalizedExecutableToolCalls;
      if (automaticServiceRecovery) {
        split.executableToolCalls = [automaticServiceRecovery];
      }
      const cachedSuccess = reuseCachedSuccessfulActions(executableToolCalls, state.toolResults);
      const verifierOwnedGuard = guardVerifierOwnedPathMutations(cachedSuccess.allowed);
      const batchGuard = guardRepeatedReadOnlyBatch(verifierOwnedGuard.allowed, split, state.readOnlyBatchSignatures, state.toolResults);
      const readOnlyDriftGuard = guardImplementationReadOnlyDrift(
        batchGuard.allowed,
        split,
        state.executionPlan?.[state.currentStepIndex],
        state.readOnlyBatchSignatures,
        state.toolResults,
      );
      const repeatGuard = guardRepeatedFailedToolCalls(readOnlyDriftGuard.allowed, state.toolResults, {
        blockSameBatchDependentActions: false,
        allowSourceDeletionInAllocatedWorkspace: isAllocatedScratchWorkspace(this.input.workspaceRoot),
      });
      const artifactGuard = guardMissingArtifactValidationBeforeProducer(repeatGuard.allowed, state.toolResults);
      const diagnosticTargetGuard = guardDiagnosticTargetedActions(artifactGuard.allowed, state.toolResults);
      const serviceNetworkGuard = guardSandboxServiceNetworkActions(diagnosticTargetGuard.allowed, state.toolResults);
      const condaRecoveryGuard = guardCondaRecoveryActions(serviceNetworkGuard.allowed, state.toolResults);
      const currentStep = state.executionPlan?.[state.currentStepIndex];
      const progressGuardConfig = this.config.runtime.progressGuard;
      const currentStepResults = state.mode === "autonomous" ? state.toolResults.slice(Math.max(0, state.currentStepToolStartIndex ?? 0)) : state.toolResults;
      const progressGuard = guardNoProgressToolCalls(condaRecoveryGuard.allowed, currentStepResults, {
        runId: getBoot().state.runId,
        enabled: progressGuardConfig.enabled,
        actionRepeatLimit: progressGuardConfig.actionRepeatLimit,
        observationRepeatLimit: progressGuardConfig.observationRepeatLimit,
        sameFailedActionLimit: progressGuardConfig.sameFailedActionLimit,
        recoveryStrategyRepeatLimit: progressGuardConfig.recoveryStrategyRepeatLimit,
        ...(currentStep?.id ? { currentStepId: currentStep.id } : {}),
      });
      if (progressGuard.tripped) {
        for (const trip of progressGuard.trips) {
          await getAuditLogger().write({
            event_id: randomUUID(),
            run_id: getBoot().state.runId,
            session_id: getBoot().state.sessionId,
            trace_id: getBoot().state.runId,
            timestamp: new Date().toISOString(),
            log_schema_version: 1,
            kind: "no_progress_detected",
            severity: "warn",
            message: `Progress guard blocked repeated action: ${trip.reason}`,
            sig: trip.sig,
            count: trip.count,
            ...(trip.planStepId ? { plan_step_id: trip.planStepId } : {}),
            details: {
              observationHash: trip.observationHash,
              planStepTitle: currentStep?.title,
            },
          });
        }
      }
      const relevanceGuard =
        state.mode === "autonomous"
          ? guardRelevanceGatedActions(progressGuard.allowed, {
              prompt: state.prompt,
              toolResults: state.toolResults,
              feedback: state.feedback,
              negativeConstraints: state.negativeConstraints,
              ...(state.executionPlan?.[state.currentStepIndex] ? { currentStep: state.executionPlan[state.currentStepIndex] } : {}),
            })
          : { allowed: progressGuard.allowed, blockedResults: [] };
      const blockedBeforeScheduling = [
        ...verifierOwnedGuard.blockedResults,
        ...batchGuard.blockedResults,
        ...readOnlyDriftGuard.blockedResults,
        ...repeatGuard.blockedResults,
        ...artifactGuard.blockedResults,
        ...diagnosticTargetGuard.blockedResults,
        ...serviceNetworkGuard.blockedResults,
        ...condaRecoveryGuard.blockedResults,
        ...progressGuard.blockedResults,
        ...relevanceGuard.blockedResults,
      ];
      for (const result of blockedBeforeScheduling) {
        await this.trajectoryLogger.write({
          event_id: randomUUID(),
          run_id: getBoot().state.runId,
          session_id: getBoot().state.sessionId,
          trace_id: getBoot().state.runId,
          timestamp: new Date().toISOString(),
          log_schema_version: 1,
          kind: "tool_call",
          level: "info",
          tool_name: result.name,
          decision_id: result.toolCallId,
          status: "failed",
          args: result.args,
          error: result.error,
        });
      }
      const startedEvents = split.executableToolCalls.map((toolCall) => makeEvent(activeRequest, "tool_call_started", { toolCall }));
      const mutationCheckpointResult = batchNeedsMutationCheckpoint(relevanceGuard.allowed)
        ? await createMutationCheckpointResult({
            workspaceRoot: this.input.workspaceRoot,
            runId: getBoot().state.runId,
            toolCalls: relevanceGuard.allowed,
          })
        : undefined;
      const scheduled = mutationCheckpointResult?.ok === false
        ? { results: [], aborted: false }
        : await executeToolCalls(
            relevanceGuard.allowed,
            getExecutor(),
            getRecoverySession(),
            this.input.abortSignal,
          );
      const postMutationResults =
        mutationCheckpointResult?.ok === true
          ? await createPostMutationGitResults(this.input.workspaceRoot, getBoot().state.runId)
          : [];
      const batchResults = [
        ...cachedSuccess.cachedResults,
        ...blockedBeforeScheduling,
        ...scheduled.results,
        ...(mutationCheckpointResult ? [mutationCheckpointResult] : []),
        ...postMutationResults,
      ];
      const toolResults = [...state.toolResults, ...batchResults];
      const completedEvents = batchResults.map((result) => makeEvent(activeRequest, "tool_call_completed", { result }));
      const relevanceFeedback = buildRelevanceGateFeedback(relevanceGuard.blockedResults, {
        prompt: state.prompt,
        ...(state.executionPlan?.[state.currentStepIndex] ? { currentStep: state.executionPlan[state.currentStepIndex] } : {}),
      });
      const diagnosticTargetFeedback = buildDiagnosticTargetFeedback(diagnosticTargetGuard.blockedResults);
      const encodingFeedback = buildDerivedSecretEncodingFeedback(toolResults);
      const runtimeGuardFeedback = [
        ...cachedSuccess.feedback,
        ...diagnosticTargetFeedback,
        ...progressGuard.feedback,
        ...relevanceFeedback,
        ...encodingFeedback,
      ];
      return {
        split,
        toolResults,
        feedback: runtimeGuardFeedback.length > 0 ? [...state.feedback, ...runtimeGuardFeedback] : state.feedback,
        ...(progressGuard.tripped ? { needsReplan: true } : {}),
        ...(progressGuard.negativeConstraints.length
          ? { negativeConstraints: [...state.negativeConstraints, ...progressGuard.negativeConstraints] }
          : {}),
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
        state.patchingStepIndex === null &&
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
      const autoCompleteFinalVerifiedStep =
        state.mode === "autonomous" &&
        Boolean(step) &&
        state.patchingStepIndex === null &&
        Boolean(split) &&
        !split!.completionSignal &&
        !split!.advancementSignal &&
        !lastBatchFailed &&
        state.currentStepIndex + 1 >= (state.executionPlan?.length ?? 0) &&
        isVerificationDrivenPlanStep(step) &&
        hasSuccessfulCurrentBatchAcceptanceEvidence(split!.executableToolCalls, state.toolResults);
      if (split && autoCompleteFinalVerifiedStep) {
        split = {
          ...split,
          completionSignal: {
            id: `auto-complete-${randomUUID()}`,
            name: "complete_task",
            args: {
              summary: `Final step '${step!.id}' passed its acceptance check and completed the requested task.`,
            },
          },
        };
      }
      const completionBlocker = split?.completionSignal ? getCompletionBlocker(state.toolResults, getBoot().state.runId, state.prompt, this.config) : undefined;
      const completionBackfilledTasks = completionBlocker
        ? backfillRuntimeBlockerTasks({
            runId: getBoot().state.runId,
            toolResults: state.toolResults,
            blocker: completionBlocker,
          })
        : [];
      const bestOfNCandidateRejected = Boolean(completionBlocker && getRequest().metadata?.best_of_n_child);
      if (split?.completionSignal && completionBlocker) {
        const { completionSignal: _completionSignal, ...splitWithoutCompletion } = split;
        split = splitWithoutCompletion;
      }
      const noActionBatch =
        state.mode === "autonomous" &&
        Boolean(split) &&
        split!.executableToolCalls.length === 0 &&
        !split!.completionSignal &&
        !split!.advancementSignal;
      if (split && shouldCleanupBackgroundAfterBatch(split.executableToolCalls, state.toolResults, getExecutor().getBackgroundProcesses())) {
        await getExecutor().cleanupBackgroundProcesses("post_foreground_check");
      }
      const stuckDetection = await updateStuckDetectionAfterTools({
        workspaceRoot: this.input.workspaceRoot,
        runId: getBoot().state.runId,
        previous: state.stuckDetection,
        toolResults: state.toolResults,
        expanded: this.config.runtime.expandedStuckDetection,
        ignoreNoAction: step?.type === "finalize" || state.completionGateAttempts > 0,
        ...(split ? { split } : {}),
      });
      // Legacy hidden patcher routing is removed. Failed steps stay
      // with the main coding agent and advisory subagents only.
      const readOnlyBatchFeedback =
        state.mode === "autonomous" &&
        Boolean(step) &&
        split &&
        split.executableToolCalls.length > 0 &&
        !split.advancementSignal &&
        !split.completionSignal &&
        !lastBatchFailed
          ? [
              ...state.feedback,
              `Step '${step!.id}' did not advance because the model did not emit advance_step. The executor must explicitly call advance_step with evidence when the current step is done, or complete_task with a final summary only when the whole task is complete.`,
              state.readOnlyBatchSignatures.length >= 2
                ? `Step '${step!.id}' has repeated inspection-only batches without progress. Stop reading the same context. Run the step's concrete command/check, make the required edit, request a patch for a real failure, or advance with evidence.`
                : "",
            ]
              .filter(Boolean)
          : state.feedback;
      const deadlinePressure = getRuntimeDeadlinePressure(startedAt);
      const deadlineAwareFeedback =
        deadlinePressure.feedback && !readOnlyBatchFeedback.includes(deadlinePressure.feedback)
          ? [...readOnlyBatchFeedback, deadlinePressure.feedback]
          : readOnlyBatchFeedback;
      const stepToolResultCount = Math.max(0, state.toolResults.length - (state.currentStepToolStartIndex ?? 0));
      const stepBudgetDecision = evaluateStepBudget({
        currentStepToolResultCount: stepToolResultCount,
        totalToolResultCount: state.toolResults.length,
        results: state.toolResults,
        ...(step ? { currentStep: { id: step.id, title: step.title, ...(step.type ? { type: step.type } : {}) } } : {}),
      });
      const budgetAwareFeedback =
        stepBudgetDecision.feedback.length > 0
          ? [...deadlineAwareFeedback, ...stepBudgetDecision.feedback.filter((item) => !deadlineAwareFeedback.includes(item))]
          : deadlineAwareFeedback;
      const completionBlockerFeedback = completionBlocker
        ? [
            ...budgetAwareFeedback,
            completionBlocker,
            ...(completionBackfilledTasks.length
              ? [`Backfilled ${completionBackfilledTasks.length} unresolved completion blocker(s) into the session task list so they cannot be missed.`]
              : []),
            "The complete_task signal was rejected because runtime evidence still contains unresolved blockers. Repair the blockers, run the smallest producer/build/test/check that proves them fixed, then emit complete_task only after that evidence exists.",
          ]
        : budgetAwareFeedback;
      const autoAdvanceReadOnlyInspection =
        state.mode === "autonomous" &&
        Boolean(step) &&
        state.patchingStepIndex === null &&
        !split?.completionSignal &&
        !split?.advancementSignal &&
        !lastBatchFailed &&
        !stuckDetection.tripped &&
        isReadOnlyInspectionStepDone(step, split);
	      const autoAdvanceVerifiedCommandStep =
	        state.mode === "autonomous" &&
	        Boolean(step) &&
	        state.patchingStepIndex === null &&
        !split?.completionSignal &&
        !split?.advancementSignal &&
        !lastBatchFailed &&
        !stuckDetection.tripped &&
	        isVerificationDrivenPlanStep(step) &&
	        Boolean(split) &&
	        hasSuccessfulCurrentBatchVerification(split!.executableToolCalls, state.toolResults);
	      const autoAdvanceStaticPlannedStep =
	        state.mode === "autonomous" &&
	        Boolean(step) &&
	        step!.tool_calls.length > 0 &&
	        state.patchingStepIndex === null &&
	        !split?.completionSignal &&
		        !split?.advancementSignal &&
	        !lastBatchFailed &&
	        !stuckDetection.tripped &&
	        state.currentStepIndex + 1 < (state.executionPlan?.length ?? 0);
	      const shouldAdvancePlanStep =
	        state.mode === "autonomous" &&
	        Boolean(step) &&
        state.patchingStepIndex === null &&
        !split?.completionSignal &&
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
        !split?.completionSignal &&
        !lastBatchFailed &&
        isReadOnlyPlanStep(step);
      const patchAttemptStepId = step?.id;
      const nextPatchAttemptsByStep = state.patchAttemptsByStep;
      const patchAttemptCount = patchAttemptStepId ? nextPatchAttemptsByStep[patchAttemptStepId] ?? 0 : 0;
      const shouldAdvanceCurrentStep = shouldAdvancePlanStep || explicitReadOnlyStepAdvance;
      const finalStepAdvancedWithoutCompletion =
        shouldAdvanceCurrentStep && state.currentStepIndex + 1 >= (state.executionPlan?.length ?? 0);
	      const advancementBlocker = shouldAdvanceCurrentStep && step && !shouldSkipOptionalExploratoryStep && !shouldAdvanceBuildConfigStep ? getPlanStepAdvancementBlocker({
	        workspaceRoot: this.input.workspaceRoot,
	        step,
	        toolResults: state.toolResults,
	      }) : undefined;
	      const advancementBlockerResult =
	        advancementBlocker && split?.advancementSignal
	          ? {
              toolCallId: split.advancementSignal.id,
              name: "advance_step",
              ok: false,
              durationMs: 0,
              args: split.advancementSignal.args,
              error: {
                code: "advance_step_blocked",
                message:
                  `Reaper rejected advance_step for '${step!.id}' because step completion evidence is insufficient: ${advancementBlocker}. ` +
                  "Do not repeat advance_step for this step. Make the missing artifact/check real, or run a narrow command that proves the success criteria are already satisfied.",
              },
            } satisfies ToolResult
          : undefined;
      const canAdvancePlanStep = shouldAdvanceCurrentStep && !advancementBlocker;
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
      if (stuckDetection.tripped) {
        addQueuedNegativeConstraint(stuckDetection.reason ?? "Detected repeated ineffective tool execution.");
      } else if (boundaryPivot) {
        addQueuedNegativeConstraint(boundaryPivot.negativeConstraint);
      }
      if (completionBlocker) {
        addQueuedNegativeConstraint(
          "Do not emit complete_task while recent tool results show missing output artifacts, failed builds, or failed runtime/verification checks without a later successful producer/check.",
        );
      }
      addQueuedNegativeConstraint(deadlinePressure.negativeConstraint);
      if (stepBudgetDecision.tripped && !canAdvancePlanStep && !split?.completionSignal) {
        for (const constraint of stepBudgetDecision.negativeConstraints) addQueuedNegativeConstraint(constraint);
      }
      const queuedRuntimeBlockers: RuntimeBlocker[] = [];
      if (completionBlocker) {
        queuedRuntimeBlockers.push({
          source: "completion_validation",
          code: "runtime_completion_blocker",
          message: completionBlocker,
        });
      }
      if (stuckDetection.tripped) {
        queuedRuntimeBlockers.push({
          source: "progress_guard",
          code: "progress_guard_blocked",
          message: stuckDetection.reason ?? "Progress guard blocked repeated ineffective tool execution.",
        });
      }
      if (noActionBatch) {
        queuedRuntimeBlockers.push({
          source: "runtime",
          code: "empty_main_agent_batch",
          message: "The main_agent response produced no executable tool calls and no completion signal.",
        });
      }
      const nextCompletionGateAttempts = queuedRuntimeBlockers.length > 0
        ? state.completionGateAttempts + 1
        : canAdvancePlanStep
          ? 0
          : Number.isFinite(state.completionGateAttempts)
            ? state.completionGateAttempts
            : 0;
      const blockerAttemptLimit = stuckDetection.tripped
        ? Math.max(1, this.config.runtime.progressGuard.stallSteps)
        : this.config.runtime.completionGateMax;
      const forcedAdvanceForBudget =
        stepBudgetDecision.tripped &&
        state.mode === "autonomous" &&
        Boolean(step) &&
        Boolean(split) &&
        !split?.advancementSignal &&
        !split?.completionSignal;
      if (forcedAdvanceForBudget && split && step) {
        split = {
          ...split,
          advancementSignal: {
            id: `budget-advance-${randomUUID()}`,
            name: "advance_step",
            args: {
              summary: `Step '${step.id}' reached the per-step tool budget (${stepToolResultCount}) without a passing verification signal. Runtime is auto-advancing to the next plan step to avoid an unbounded loop.`,
              evidence: [
                `Step '${step.id}' reached the per-step tool budget (${stepToolResultCount}) without a passing verification signal. Runtime is auto-advancing to the next plan step to avoid an unbounded loop. The next executor subagent should pick up this step's remaining work.`,
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
        ...(advancementBlockerResult ? { toolResults: [...state.toolResults, advancementBlockerResult] } : {}),
        lastBatchFailed,
        stuckDetection,
        runtimeBlockers: queuedRuntimeBlockers.length > 0 ? [...state.runtimeBlockers, ...queuedRuntimeBlockers] : state.runtimeBlockers,
        readOnlyBatchSignatures,
        ...(boundaryPivot || (stepBudgetDecision.tripped && !canAdvancePlanStep && !split?.completionSignal) ? { needsReplan: true } : {}),
        patchAttemptsByStep: nextPatchAttemptsByStep,
        completionGateAttempts: nextCompletionGateAttempts,
        ...(bestOfNCandidateRejected || (queuedRuntimeBlockers.length > 0 && nextCompletionGateAttempts >= blockerAttemptLimit) ? { completionGateExhausted: true } : {}),
        ...(queuedNegativeConstraints.length !== state.negativeConstraints.length
          ? { negativeConstraints: queuedNegativeConstraints }
          : {}),
        feedback: advancementBlocker
            ? [
                ...completionBlockerFeedback,
                `Reaper rejected advance_step for '${step!.id}' because step completion evidence is insufficient: ${advancementBlocker}`,
                "Do not advance this step yet. Repair/create the missing target or replace stub implementation with real task logic, then run the smallest relevant build/runtime/output check.",
              ]
          : shouldAdvancePlanStep
          ? finalStepAdvancedWithoutCompletion
            ? [
                `Final planned step '${step!.id}' advanced. The next model response must emit complete_task with args.summary if the whole requested task is complete, or concrete repair/check tool calls if work remains.`,
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
                ...completionBlockerFeedback,
                "The last model response produced no executable tool calls and no completion/advance signal. This is not progress; inspect the needed files or make the smallest concrete repair before continuing.",
              ]
            : stuckDetection.tripped
              ? [
                  ...completionBlockerFeedback,
                  stuckDetection.reason ?? "Repeated ineffective tool execution detected.",
                  "Stop repeating the same failed action. Choose a materially different implementation path, inspect relevant files, or replan the current step around the failure evidence.",
                ]
              : completionBlockerFeedback,
        ...(boundaryPivot
          ? {
              feedback: [
                ...completionBlockerFeedback,
                boundaryPivot.feedback,
              ],
            }
          : {}),
        ...(canAdvancePlanStep
          ? {
          currentStepIndex: state.currentStepIndex + 1,
          currentStepToolStartIndex: state.toolResults.length,
          completedStepIds: [...state.completedStepIds, step!.id],
          patchingStepIndex: null,
        }
          : {}),
      };
      // Best-effort: keep .reaper/PLAN.md in sync with step completion
      // (Claude Code / Pi pattern). Fire-and-forget so a slow write doesn't
      // block the graph node. Errors are logged but not fatal.
      if (canAdvancePlanStep) {
      }
    };

    const verifyNode = async (state: GraphState) => {
      if (!state.split?.completionSignal) return {};
      if (shouldRunVerificationForCompletion(getRequest(), state.split.completionSignal, this.config) || state.mode === "autonomous") {
        const explicitVerification = await runExplicitVerification({
          workspaceRoot: this.input.workspaceRoot,
          completionSignal: state.split.completionSignal,
          request: getRequest(),
          trajectoryLogger: this.trajectoryLogger,
          auditLogger: getAuditLogger(),
          toolResults: state.toolResults,
          modelGateway: this.input.modelGateway,
          config: this.config,
        });
        const backfilledTasks = explicitVerification.ok
          ? []
          : backfillVerificationFailureTasks({
              runId: getBoot().state.runId,
              verification: explicitVerification,
              toolResults: state.toolResults,
            });
        const stuckDetection = await updateStuckDetectionAfterVerification({
          workspaceRoot: this.input.workspaceRoot,
          runId: getBoot().state.runId,
          previous: state.stuckDetection,
          verification: explicitVerification,
        });
        if (!explicitVerification.ok) {
          const classified = classifyVerificationOutput(
            [
              explicitVerification.command ?? "",
              ...(explicitVerification.feedback ?? []),
              ...(explicitVerification.negativeConstraints ?? []),
            ].join("\n"),
          );
          await appendFailureMemory(this.input.workspaceRoot, {
            runId: getBoot().state.runId,
            source: "verification",
            summary: classified.repairStrategy,
            failureClasses: classified.classes,
            negativeConstraints: explicitVerification.negativeConstraints ?? [],
          }).catch(() => undefined);
        }
        const verificationState = explicitVerification.command
          ? recordVerificationCheck(state.verificationState ?? createVerificationState(), {
              command: explicitVerification.command,
              status: explicitVerification.ok ? "passed" : "failed",
              evidence: [
                explicitVerification.groundedSignal?.kind ?? "",
                explicitVerification.groundedSignal?.command ?? "",
                explicitVerification.selfDebugExplanation ?? "",
                explicitVerification.diffReviewExplanation ?? "",
                ...(explicitVerification.feedback ?? []),
              ].filter(Boolean).join("\n"),
              verifiedAt: new Date().toISOString(),
            })
          : state.verificationState;
        const verificationBlockers: RuntimeBlocker[] = explicitVerification.ok
          ? []
          : [
              {
                source: "verification",
                code: "verification_failed",
                message: (explicitVerification.feedback ?? []).join("\n") || "Completion verification failed.",
                ...(explicitVerification.failureClasses ? { details: explicitVerification.failureClasses } : {}),
              },
            ];
        return {
          explicitVerification,
          ...(verificationState ? { verificationState } : {}),
          stuckDetection,
          runtimeBlockers: explicitVerification.ok ? [] : [...state.runtimeBlockers, ...verificationBlockers],
          feedback: explicitVerification.ok
            ? state.feedback
            : [
                ...state.feedback,
                ...(explicitVerification.feedback ?? []),
                ...(backfilledTasks.length ? [`Backfilled ${backfilledTasks.length} failed verification blocker(s) into the session task list. Complete those tasks before retrying complete_task.`] : []),
              ],
          negativeConstraints: explicitVerification.ok ? state.negativeConstraints : [...state.negativeConstraints, ...(explicitVerification.negativeConstraints ?? [])],
        };
      }
      return {
        explicitVerification: {
          ok: true,
          attemptCount: 0,
          retryBudgetConsumed: 0,
          command: "model_managed_testing_step",
          feedback: ["Reaper automatic verification is disabled. The model is responsible for testing as part of the execution plan before complete_task."],
          negativeConstraints: [],
        },
      };
    };

    const summarizeNode = async (state: GraphState) => {
      const activeRequest = getRequest();
      const finalVerification = state.explicitVerification;
      const contentPrep = await prepareRuntimeContent({
        workspaceRoot: this.input.workspaceRoot,
        prompt: state.prompt,
        maxContextTokens: Math.max(2000, Math.floor(getBoot().state.tokenBudget.softCap * 0.1)),
        prunerConfig: this.config.pruner,
        toolResults: state.toolResults,
        backgroundProcesses: getExecutor().getBackgroundProcesses(),
        ...(mcpRegistry ? { mcpRegistry } : {}),
        ...(this.input.middlewares ? { middlewares: this.input.middlewares as any } : {}),
      });
	      const assistantMessage =
	        state.split?.completionSignal?.args.summary?.trim() ||
	        (state.mode === "autonomous" && !state.split?.completionSignal
	          ? state.completionGateExhausted
              ? `Task stopped after the completion gate exhausted ${state.completionGateAttempts} attempt(s) without a valid complete_task or concrete remaining work signal.`
              : state.stuckDetection.tripped
	            ? `Task appears stuck: ${state.stuckDetection.reason ?? "repeated ineffective tool execution detected."}`
	            : "Task ended without the required model complete_task signal."
	          : this.input.modelGateway
	          ? await generateFinalSummary({
              prompt: state.prompt,
              toolResults: state.toolResults,
	              verification: finalVerification,
	              ...(this.input.modelGateway ? { modelGateway: this.input.modelGateway } : {}),
	              role: modelRoute(this.config, "summarizer"),
	              ...(state.stuckDetection.tripped && state.stuckDetection.reason ? { stuckReason: state.stuckDetection.reason } : {}),
            })
          : summarizeExplicitToolRun(state.toolResults));
      const nextEvents = [...state.events, makeEvent(activeRequest, "assistant_message", { content: assistantMessage })];
      const canComplete =
        state.mode === "autonomous"
          ? Boolean(state.split?.completionSignal) && finalVerification?.ok !== false && !getCompletionBlocker(state.toolResults, getBoot().state.runId, state.prompt, this.config)
          : state.toolResults.every((result) => result.ok) && finalVerification?.ok !== false;
	      if (canComplete) {
	        const committedKnowledge = await commitVerifiedRunKnowledge({
	          workspaceRoot: this.input.workspaceRoot,
	          runId: getBoot().state.runId,
	          prompt: state.prompt,
	          assistantMessage,
	          toolResults: state.toolResults,
	          ...(finalVerification ? { verification: finalVerification } : {}),
	        }).catch((): Awaited<ReturnType<typeof commitVerifiedRunKnowledge>> => ({}));
	        if (committedKnowledge.lesson) {
	          await getAuditLogger().write({
	            event_id: randomUUID(),
	            run_id: getBoot().state.runId,
	            session_id: getBoot().state.sessionId,
	            trace_id: getBoot().state.runId,
	            timestamp: new Date().toISOString(),
	            log_schema_version: 1,
	            kind: "lesson_recorded",
	            severity: "warn",
	            message: `Recorded verified lesson ${committedKnowledge.lesson.id}`,
	            details: {
	              lesson_id: committedKnowledge.lesson.id,
	              tags: committedKnowledge.lesson.tags,
	              provenance: committedKnowledge.lesson.provenance,
	            },
	          });
	        }
	        if (committedKnowledge.skill) {
	          await getAuditLogger().write({
	            event_id: randomUUID(),
	            run_id: getBoot().state.runId,
	            session_id: getBoot().state.sessionId,
	            trace_id: getBoot().state.runId,
	            timestamp: new Date().toISOString(),
	            log_schema_version: 1,
	            kind: "skill_committed",
	            severity: "warn",
	            message: `Committed verified skill ${committedKnowledge.skill.name}`,
	            details: {
	              skill_name: committedKnowledge.skill.name,
	              file_path: committedKnowledge.skill.filePath,
	            },
	          });
	        }
	        nextEvents.push(makeEvent(activeRequest, "task_completed", { verification: finalVerification }));
	      }
      return {
        contentPrep,
        contentFingerprint: contentPrep.preparedContext.fingerprint,
        assistantMessage,
        events: nextEvents,
        explicitVerification: finalVerification,
        done: true,
      };
    };

	    const metricsNode = async (state: GraphState) => {
	      const activeBoot = getBoot();
	      const taskCompleted = state.events.some((event) => event.message_type === "task_completed");
	      const sessionMetrics = buildSessionMetricsSummary({
	        toolResults: state.toolResults,
	        completionGateAttempts: state.completionGateAttempts,
	        taskCompleted,
	        verifiedCompletion: taskCompleted && state.explicitVerification?.ok !== false,
	        stuckTripped: state.stuckDetection.tripped,
	        gateExhausted: state.completionGateExhausted,
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
      return "inspect_project";
    };
    const routeAfterInspectProject = () => "extract_task_contract";
    const routeAfterExtractTaskContract = () => "content_prep";
    const routeAfterContentPrep = (state: GraphState) => {
      if (state.mode !== "autonomous") return "categorize_tools";
      return "main_agent";
    };
    const routeAfterMainAgent = (state: GraphState) => {
      if (state.completionGateExhausted) return "summarize";
      const latestBlocker = state.runtimeBlockers.at(-1);
      if ((latestBlocker?.source === "schema" || latestBlocker?.source === "model") && !(state.plannedToolCalls?.length)) return "main_agent";
      return "validate_tool_calls";
    };
    const routeAfterToolValidation = (state: GraphState) => {
      if (state.completionGateExhausted) return "summarize";
      if (state.runtimeBlockers.length > 0 && !(state.plannedToolCalls?.length)) return "main_agent";
      if (state.split?.completionSignal) return "verify_completion";
      if ((state.split?.executableToolCalls.length ?? 0) > 0) return "permission_check";
      return "main_agent";
    };
    const routeAfterQueue = (state: GraphState) => {
      if (state.mode !== "autonomous") return "verify";
      if (state.completionGateExhausted) return "summarize";
      const currentBatchFailed = state.split ? state.lastBatchFailed && hasFailedCurrentBatch(state.split.executableToolCalls, state.toolResults) : state.lastBatchFailed;
      if (state.split?.completionSignal && !currentBatchFailed) return "verify_completion";
      return "main_agent";
    };
    const routeAfterCompletionValidation = (state: GraphState) => {
      if (state.completionGateExhausted) return "summarize";
      if (state.runtimeBlockers.length > 0 && !state.split?.completionSignal) return "main_agent";
      return shouldRunVerificationForCompletion(getRequest(), state.split?.completionSignal, this.config) ? "verify" : "summarize";
    };
    const routeAfterVerify = (state: GraphState) => {
      if (state.mode !== "autonomous") return "summarize";
      if (state.explicitVerification?.ok) return "summarize";
      if (state.completionGateExhausted) return "summarize";
      return "main_agent";
    };

    const graph = new StateGraph(ReaperGraphState)
      .addNode("bootstrap", bootstrapNode)
      .addNode("inspect_project", inspectProjectNode)
      .addNode("extract_task_contract", extractTaskContractNode)
      .addNode("content_prep", contentPrepNode)
      .addNode("main_agent", mainAgentNode)
      .addNode("validate_tool_calls", validateToolCallsNode)
      .addNode("verify_completion", verifyCompletionNode)
      .addNode("categorize_tools", categorizeToolsNode)
      .addNode("permission_check", permissionCheckNode)
      .addNode("execute_tools", executeToolsNode)
      .addNode("queue_results", queueResultsNode)
      .addNode("verify", verifyNode)
      .addNode("summarize", summarizeNode)
      .addNode("no_model", noModelNode)
      .addNode("metrics", metricsNode)
      .addEdge(START, "bootstrap")
      .addConditionalEdges("bootstrap", routeAfterBootstrap as any, ["inspect_project", "categorize_tools", "no_model"])
      .addConditionalEdges("inspect_project", routeAfterInspectProject as any, ["extract_task_contract"])
      .addConditionalEdges("extract_task_contract", routeAfterExtractTaskContract as any, ["content_prep"])
      .addConditionalEdges("content_prep", routeAfterContentPrep as any, ["main_agent", "categorize_tools"])
      .addConditionalEdges("main_agent", routeAfterMainAgent as any, ["validate_tool_calls", "main_agent", "summarize"])
      .addConditionalEdges("validate_tool_calls", routeAfterToolValidation as any, ["verify_completion", "permission_check", "main_agent", "summarize"])
      .addEdge("categorize_tools", "permission_check")
      .addEdge("permission_check", "execute_tools")
      .addEdge("execute_tools", "queue_results")
      .addConditionalEdges("queue_results", routeAfterQueue as any, ["verify_completion", "main_agent", "verify", "summarize"])
      .addConditionalEdges("verify_completion", routeAfterCompletionValidation as any, ["verify", "main_agent", "summarize"])
      .addConditionalEdges("verify", routeAfterVerify as any, ["summarize", "main_agent"])
      .addEdge("summarize", "metrics")
      .addEdge("no_model", "metrics")
      .addEdge("metrics", END)
      .compile({ checkpointer: new MemorySaver() });

    // Register scoped cleanup for this run
    const executorInstance = executor;
    const mcpRegistryInstance = mcpRegistry;
    const subagentPoolInstance = subagentPool;
    const unregisterExecutorCleanup = executorInstance
      ? registerCleanup(async () => {
          await executorInstance.cleanupBackgroundProcesses("runtime_finished");
        })
      : undefined;
    const unregisterSubagentCleanup = subagentPoolInstance
      ? registerCleanup(async () => {
          await subagentPoolInstance.close();
        })
      : undefined;
    const unregisterMcpCleanup = mcpRegistryInstance
      ? registerCleanup(async () => {
          await (mcpRegistryInstance as any).closeAll?.().catch(() => undefined);
        })
      : undefined;

    try {
      const finalState = await graph.invoke(
        {
          prompt: "",
          toolResults: [],
          events: [],
          assistantMessage: "",
          runtimeBlockers: [],
          feedback: [],
          negativeConstraints: [],
          iteration: 0,
          currentStepIndex: 0,
          currentStepToolStartIndex: 0,
          completedStepIds: [],
          patchingStepIndex: null,
          patchAttemptsByStep: {},
          rescueWatchdog: createRescueWatchdogState(),
          lastBatchFailed: false,
          completionGateAttempts: 0,
          completionGateExhausted: false,
          shouldCompact: false,
          stuckDetection: createStuckDetectionState(),
          stuckReplanCount: 0,
          done: false,
        },
        { configurable: { thread_id: runContext.threadId }, recursionLimit: getGraphRecursionLimit() },
      );

      const finalBoot = finalState.boot ?? boot;
      if (!finalBoot) throw new Error("LangGraph runtime ended without boot state");

      const result: RuntimeEngineResult = {
        state: finalBoot.state,
        toolResults: finalState.toolResults,
        assistantMessage: finalState.assistantMessage,
        events: finalState.events,
        trajectoryPath: this.trajectoryLogger.path,
        ...(finalState.contentFingerprint ? { contentFingerprint: finalState.contentFingerprint } : {}),
        ...(finalState.explicitVerification ? { verification: finalState.explicitVerification } : {}),
      };
      const finalStatus = classifyRunFinalStatus(finalState);
      await persistExecutionPlanProgress(this.input.workspaceRoot, finalBoot.state.runId, {
        currentStepIndex: finalState.currentStepIndex,
        completedStepIds: finalState.completedStepIds,
        failed: finalStatus === "failed",
      });
      await persistRunResult(runContext, result, finalStatus);
      return result;
    } catch (error) {
      await persistRunFailure(runContext, error);
      throw error;
    } finally {
      unregisterExecutorCleanup?.();
      unregisterSubagentCleanup?.();
      unregisterMcpCleanup?.();
      await runCleanupFunctions();
      await writeLatestRunPointer(this.input.workspaceRoot, runContext);
    }
  }
}

function classifyRunFinalStatus(state: {
  stuckDetection: StuckDetectionState | undefined;
  explicitVerification: RuntimeEngineResult["verification"] | undefined;
  mode: GraphMode | undefined;
  split?: SplitToolCalls | undefined;
  toolResults: ToolResult[] | undefined;
  completionGateExhausted?: boolean | undefined;
}): "completed" | "failed" {
  if (state.completionGateExhausted) return "failed";
  if (state.stuckDetection?.tripped) return "failed";
  if (state.explicitVerification?.ok === false) return "failed";
  if (state.explicitVerification?.ok === true) return "completed";
  if (state.mode === "autonomous" && state.split?.completionSignal) return "completed";
  if (state.mode === "autonomous" && !state.explicitVerification?.ok) return "failed";
  if ((state.toolResults ?? []).some((item) => !item.ok)) return "failed";
  return "completed";
}

async function persistRunFailure(runContext: ReaperRunContext, error: unknown): Promise<void> {
  await mkdir(runContext.runDir, { recursive: true });
  await writeFile(
    path.join(runContext.runDir, "result.json"),
    JSON.stringify(
      {
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        traceId: runContext.traceId,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function renderToolResultSnippet(result: ToolResult): string {
  return JSON.stringify(renderToolResultForModel(result)).slice(0, 9000);
}

function applyAdvisoryToolCalls(
  state: Pick<GraphState, "planState" | "todoState">,
  calls: Array<Extract<ToolCall, { name: "update_plan" | "update_todo" }>>,
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

function makeAdvisoryToolResult(call: Extract<ToolCall, { name: "update_plan" | "update_todo" }>, output: unknown): ToolResult {
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
  return toolCalls.filter((call) => !["complete_task", "advance_step", "delegate_to_plan", "update_plan", "update_todo"].includes(call.name));
}

function isAllocatedScratchWorkspace(workspaceRoot: string): boolean {
  const normalized = path.resolve(workspaceRoot).replace(/\\/g, "/");
  return (
    /\/reaper_eval\/workspaces\/[^/]+\/[^/]+(?:\/|$)/.test(normalized) ||
    /\/(?:tmp|var\/tmp)\/reaper(?:-|_|\/)/i.test(normalized) ||
    /\/\.reaper\/scratchpad(?:\/|$)/.test(normalized)
  );
}

function guardRepeatedFailedToolCalls(
  toolCalls: ToolCall[],
  previousResults: ToolResult[],
  options: { blockSameBatchDependentActions?: boolean; allowSourceDeletionInAllocatedWorkspace?: boolean } = {},
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const unsafeLineRangeEditIds = findUnsafeSameFileLineRangeEditIds(toolCalls);
  const failedCounts = countFailedActionSignatures(previousResults);
  const successfulDependencySetupCounts = countSuccessfulDependencySetupSignatures(previousResults);
  const recentBroadTestTimeouts = countRecentBroadTestTimeoutFailures(previousResults);
  const repeatedLowInformation = countTrailingLowInformationActionSignatures(previousResults);
  const recentLowInformation = countRecentLowInformationActionSignatures(previousResults);
  for (const call of toolCalls) {
    if (unsafeLineRangeEditIds.has(call.id)) {
      const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
      const targetPath = typeof args.path === "string" ? args.path : "unknown";
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "unsafe_same_file_line_range_batch_blocked",
          message:
            `Reaper blocked a same-batch line-range edit to '${targetPath}' because an earlier edit in the same file changes line numbers before a later line-range edit. ` +
            "Apply same-file line-range edits from bottom to top, combine them into one coherent full-region replacement, or split them into separate read/edit/check batches. This prevents stale line numbers from corrupting source files.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockMaskedVerificationPipe(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "masked_verification_pipe_blocked",
          message:
            "Reaper blocked a build/test/runtime verification command piped to an output truncation command because the pipeline can hide the real failing exit code. " +
            "Rerun the check with preserved status, for example: set -o pipefail; <command> 2>&1 | tail -200, or redirect output to a log file then inspect the log after checking the command exit code.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockUnboundedRetryLoopShellCommand(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "unbounded_retry_loop_blocked",
          message:
            "Reaper blocked a shell command that appears to run an unbounded retry loop around a network/service probe. " +
            "Use a bounded retry loop with a small max attempt count or deadline, fail nonzero when the dependency is unavailable, and keep any long service checks behind an explicit timeoutMs.",
        },
      });
      continue;
    }
    if (
      call.name === "run_shell_command" &&
      !options.allowSourceDeletionInAllocatedWorkspace &&
      shouldBlockSourceDeletionShellCommand(getShellCommandArg(call))
    ) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "source_deletion_shell_command_blocked",
          message:
            "Reaper blocked a shell command that deletes source/config files outside generated build/cache directories. " +
            "Do not remove project source/header/config files with rm to fix compatibility issues. Patch the file contents with edit/write tools, or delete only generated build/cache artifacts when needed.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockVerifierOwnedShellMutation(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "verifier_owned_path_write_blocked",
          message:
            "Reaper blocked a shell command that mutates external verifier-owned absolute /tests paths. Treat harness files as read-only and satisfy their checks by changing workspace source/artifacts instead.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockBuildConfigShellWrite(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "build_config_shell_write_blocked",
          message:
            "Reaper blocked a fragile shell command that writes build/project configuration inside or around a build directory. " +
            "Create or update project configuration files with write_file/edit_file in the source directory, then run the build tool with explicit source/build flags (for example cmake -S <source-dir> -B <build-dir>). Do not generate CMakeLists/package/project files with printf/heredoc shell commands inside build directories.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockEmptySourcePlaceholderShellCommand(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "source_empty_placeholder_shell_blocked",
          message:
            "Reaper blocked a shell command that creates or truncates empty source placeholders. Create source files with complete intended content using write_file, or delete scratch placeholders with delete_file.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockSourceShellWrite(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "source_shell_write_blocked",
          message:
            "Reaper blocked a shell heredoc/redirect source write. Create source files with write_file and extend them with replace_in_file/edit_file so size, freshness, and truncation guards can keep the implementation reliable.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockSyntheticResultOrMockService(getShellCommandArg(call), getShellSummaryArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "synthetic_result_or_mock_service_blocked",
          message:
            "Reaper blocked a command that appears to fabricate a final artifact or replace an unavailable external service with a mock/hardcoded success path. " +
            "Do not write guessed result files, hardcoded success strings, or mock services as task completion evidence. Use the real service/tool, repair the environment, or produce a verifiable implementation whose output is derived from workspace inputs and checked by a real command.",
        },
      });
      continue;
    }
    if (shouldBlockSyntheticServiceFileMutation(call)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "synthetic_result_or_mock_service_blocked",
          message:
            "Reaper blocked a source/artifact mutation that appears to create a local mock service or hardcoded response for a final result path. " +
            "Do not replace unavailable services with fabricated success behavior. Repair the real service path, derive outputs from actual workspace inputs, or implement task-facing code that can be verified without hardcoded final artifacts.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockCombinedSourceMutationAndCheck(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "combined_source_mutation_and_check_blocked",
          message:
            "Reaper blocked a shell command that mutates source/config files and runs build/test/runtime verification in the same command. " +
            "Use read_file plus write_file/replace_in_file/edit_file for the source change, then run the build/test/runtime check as a separate run_shell_command so failures are attributable and recoverable.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && shouldBlockRuntimeBeforeSuccessfulBuild(getShellCommandArg(call), previousResults)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "missing_build_artifact_runtime_blocked",
          message:
            "Reaper blocked running a build artifact because recent build/compile commands failed or the artifact was missing. " +
            "Do not rerun the binary/runtime command yet. Inspect the latest build diagnostics, fix the build configuration or source error, run the build successfully, then run the artifact.",
        },
      });
      continue;
    }
    if (options.blockSameBatchDependentActions !== false && call.name === "run_shell_command" && shouldBlockSameBatchDependentCheck(call, toolCalls, previousResults)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "same_batch_dependent_check_blocked",
          message:
            "Reaper blocked a check/verification command batched with a state-changing repair/setup action it may depend on. " +
            "Run the repair/setup first, observe its result, then run the dependent check in the next model turn so stdout/stderr reflects the new state.",
        },
      });
      continue;
    }
    if (options.blockSameBatchDependentActions !== false && shouldBlockSameBatchReadOnlyInspection(call, toolCalls)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "same_batch_dependent_check_blocked",
          message:
            "Reaper blocked a read-only inspection batched with a state-changing action it may depend on. " +
            "Run the change first, observe its result, then inspect the updated file/tree in the next model turn.",
        },
      });
      continue;
    }
    const sameStateRetryBlocker = getSameStateShellRetryBlocker(call, previousResults);
    if (sameStateRetryBlocker) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: sameStateRetryBlocker,
      });
      continue;
    }
    const dependencySetupSignature = makeDependencySetupToolCallSignature(call);
    if (dependencySetupSignature && (successfulDependencySetupCounts.get(dependencySetupSignature) ?? 0) >= 2) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "repeated_dependency_setup_blocked",
          message:
            `Reaper blocked repeated dependency/setup command '${dependencySetupSignature}' because it already succeeded at least twice without resolving the task. ` +
            "Do not reinstall or bootstrap the same toolchain again. Inspect the exact runtime path/import error, use the installed module path directly, repair the command/test environment, or choose a different minimal verification path.",
        },
      });
      continue;
    }
    if (isMutatingToolCall(call) && shouldBlockOverpatchedSourceFile(call, previousResults)) {
      const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
      const targetPath = typeof args.path === "string" ? args.path : "unknown";
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "overpatched_source_file_blocked",
          message:
            `Reaper blocked another edit to '${targetPath}' because recent history shows repeated edits to this source file plus repeated build/compile failures. ` +
            "Stop patching brittle internals. Prefer a non-invasive wrapper, adapter, compatibility shim, or standalone implementation that satisfies the acceptance criteria; if this file truly must change, first read the file and replace one small line-range with a build check.",
        },
      });
      continue;
    }
    if (call.name === "replace_in_file" && shouldBlockRepeatedExactReplace(call, previousResults)) {
      const targetPath = typeof call.args.path === "string" ? call.args.path : "unknown";
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "repeated_exact_replace_blocked",
          message:
            `Reaper blocked another exact replace_in_file on '${targetPath}' after repeated exact-replacement failures on that path. ` +
            "Use read_file with line numbers, then replace_in_file with startLine/endLine/content for the smallest affected region, or use write_file only if a full-file overwrite is intentional and the current file was read.",
        },
      });
      continue;
    }
    const lowInformationSignature = makeLowInformationToolCallSignature(call);
    if (lowInformationSignature && ((repeatedLowInformation.get(lowInformationSignature) ?? 0) >= 10 || (recentLowInformation.get(lowInformationSignature) ?? 0) >= 14)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "repeated_low_information_action_blocked",
          message:
            `Reaper blocked repeated low-information action '${lowInformationSignature}' because the same read/list action already succeeded repeatedly without progress. ` +
            "Do not read the same context again. Use the observed content to make a concrete edit/check, inspect a different artifact, advance the step with evidence, or replan around the blocker.",
        },
      });
      continue;
    }
    if (call.name === "run_shell_command" && recentBroadTestTimeouts >= 2 && isBroadTestCommand(getShellCommandArg(call))) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "repeated_broad_test_timeout_blocked",
          message:
            "Reaper blocked another broad test command after repeated test timeout/open-handle failures. " +
            "Do not rerun the full suite unchanged. Inspect the latest timeout stack, the test setup/teardown, and app/database startup code. " +
            "Then run a narrow diagnostic command, preferably a single failing test file with single-worker/open-handle diagnostics (for example the ecosystem equivalent of jest --runInBand --detectOpenHandles <file>), or switch tests to an isolated in-process/mocked/file-backed service when an external service is unavailable.",
        },
      });
      continue;
    }
    const signature = makeToolCallActionSignature(call);
    if (signature && (failedCounts.get(signature) ?? 0) >= 2) {
      if (call.name === "sandbox_service_control") {
        allowed.push(call);
        continue;
      }
      if (call.name === "run_shell_command" && hasMutationInCurrentBatch(toolCalls)) {
        allowed.push(call);
        continue;
      }
      if (call.name === "run_shell_command" && hasSuccessfulMutationAfterLatestFailure(signature, previousResults)) {
        allowed.push(call);
        continue;
      }
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "repeated_failed_action_blocked",
          message:
            `Reaper blocked repeated failed action '${signature}' because it already failed at least twice in this run. ` +
            "Do not retry the same command/edit unchanged. Inspect diagnostics and choose a materially different approach.",
        },
      });
      continue;
    }
    allowed.push(call);
  }
  return { allowed, blockedResults };
}

type LineRangeReplaceCall = Extract<ToolCall, { name: "replace_in_file" }> & {
  args: { path: string; startLine: number; endLine: number; content: string };
};

function findUnsafeSameFileLineRangeEditIds(toolCalls: ToolCall[]): Set<string> {
  const unsafeIds = new Set<string>();
  const byPath = new Map<string, LineRangeReplaceCall[]>();
  for (const call of toolCalls) {
    if (call.name !== "replace_in_file") continue;
    if (!hasLineRangeReplaceArgs(call)) continue;
    const normalizedPath = String(call.args.path).replace(/\\/g, "/");
    byPath.set(normalizedPath, [...(byPath.get(normalizedPath) ?? []), call]);
  }
  for (const calls of byPath.values()) {
    if (calls.length < 2) continue;
    let priorStartLine: number | undefined;
    let priorChangedLineCount = false;
    for (const call of calls) {
      const startLine = Number(call.args.startLine);
      if (priorChangedLineCount && priorStartLine !== undefined && startLine > priorStartLine) {
        for (const item of calls) unsafeIds.add(item.id);
        break;
      }
      if (lineRangeReplacementDelta(call) !== 0) {
        priorChangedLineCount = true;
        priorStartLine = priorStartLine === undefined ? startLine : Math.min(priorStartLine, startLine);
      }
    }
  }
  return unsafeIds;
}

function hasLineRangeReplaceArgs(call: ToolCall): call is LineRangeReplaceCall {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  return (
    call.name === "replace_in_file" &&
    typeof args.path === "string" &&
    typeof args.startLine === "number" &&
    typeof args.endLine === "number" &&
    typeof args.content === "string"
  );
}

function lineRangeReplacementDelta(call: LineRangeReplaceCall): number {
  const originalLineCount = Math.max(0, Number(call.args.endLine) - Number(call.args.startLine) + 1);
  const content = String(call.args.content);
  const replacementLineCount = content.length === 0 ? 0 : content.replace(/\n$/, "").split(/\r?\n/).length;
  return replacementLineCount - originalLineCount;
}

function shouldBlockMaskedVerificationPipe(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\|/.test(normalized)) return false;
  if (/\bset\s+-o\s+pipefail\b|bash\s+-o\s+pipefail\b|\bPIPESTATUS\b|\bSTATUS=\$\?|\bexit\s+\$status\b/i.test(normalized)) return false;
  const beforePipe = normalized.split("|")[0] ?? "";
  const afterPipe = normalized.slice(beforePipe.length + 1);
  const verificationLike = isExplicitBuildTestOrCheckCommand(beforePipe);
  if (!verificationLike) return false;
  return /\b(?:head|tail|grep|sed|awk|tee|cut|less|more)\b/i.test(afterPipe);
}

function shouldBlockUnboundedRetryLoopShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  const hasUnboundedLoop =
    /\bwhile\s+True\s*:/i.test(command) ||
    /\bwhile\s+true\s*;?\s*do\b/i.test(normalized) ||
    /\bfor\s*\(\s*;\s*;\s*\)/i.test(normalized);
  if (!hasUnboundedLoop) return false;
  const probesExternalRuntime =
    /\b(?:HTTPConnection|requests\.|urllib\.request|socket\.|curl|wget|nc|telnet|ssh|psql|mysql|redis-cli|mongo|mongosh)\b/i.test(command) ||
    /\b(?:https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)\b/i.test(command);
  if (!probesExternalRuntime) return false;
  const retriesOnFailure = /\b(?:sleep|time\.sleep|continue|retry|retries|again)\b/i.test(command);
  if (!retriesOnFailure) return false;
  const bounded =
    /\b(?:for\s+\w+\s+in\s+range\s*\(|max[_-]?(?:attempts|retries)|attempts?\s*[<]=?\s*\d+|retries\s*[<]=?\s*\d+|deadline|time\.time\s*\(\)\s*[-+<>]|Date\.now\s*\(\)\s*[-+<>])\b/i.test(
      command,
    ) || /(?:^|[;&|]\s*)timeout\s+\d+/i.test(normalized);
  return !bounded;
}

export function isExplicitBuildTestOrCheckCommand(command: string): boolean {
  return (
    isBuildCommand(command) ||
    isTestCommand(command) ||
    /\b(?:tsc|eslint|ruff|mypy|go\s+test|go\s+vet|cargo\s+(?:test|check|clippy)|mvn\s+test|gradle\s+test|playwright|cypress|smoke|python3?\s+-m\s+pytest|python3?\s+-m\s+unittest)\b/i.test(
      command,
    )
  );
}

function isCheckLikeShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (
    isExplicitBuildTestOrCheckCommand(normalized) ||
    isVerificationLikeCommand(normalized) ||
    isBuildArtifactRuntimeCommand(normalized) ||
    /(?:^|[;&|]\s*|\b&&\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate|lint|typecheck|smoke)\b/i.test(normalized) ||
    /(?:^|[;&|]\s*|\b&&\s*)(?:check|verify|validate|lint|typecheck|doctor|smoke|ctest|unittest)\b/i.test(normalized) ||
    /(?:^|[;&|]\s*|\b&&\s*)(?:cat|head|tail|wc|stat|test|ls)\b/i.test(normalized)
  );
}

function guardDiagnosticTargetedActions(
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  const target = getUnresolvedDiagnosticTarget(toolResults);
  if (!target) return { allowed: toolCalls, blockedResults: [] };
  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const batchTouchesTarget = toolCalls.some((call) => toolCallTouchesDiagnosticTarget(call, target));
  for (const call of toolCalls) {
    if (call.name === "sandbox_service_control") {
      allowed.push(call);
      continue;
    }
    if (call.name === "run_shell_command" && isSandboxServiceDiagnosticPath(getShellCommandArg(call))) {
      allowed.push(call);
      continue;
    }
    if (call.name === "run_shell_command" && shouldAllowSetupDespiteDiagnosticTarget(getShellCommandArg(call), toolResults)) {
      allowed.push(call);
      continue;
    }
    if (call.name === "run_shell_command" && shouldAllowRuntimeInspectionDespiteDiagnosticTarget(getShellCommandArg(call), toolResults)) {
      allowed.push(call);
      continue;
    }
    if (toolCallPreparesDiagnosticTargetParent(call, target)) {
      allowed.push(call);
      continue;
    }
    if (shouldAllowDependencyManifestRepairDespiteDiagnosticTarget(call, toolResults)) {
      allowed.push(call);
      continue;
    }
    if (batchTouchesTarget || isCheapDiagnosticInspection(call) || isDiagnosticClearingCheck(call)) {
      allowed.push(call);
      continue;
    }
    if (!isExpensiveOrMutatingFollowup(call)) {
      allowed.push(call);
      continue;
    }
    blockedResults.push({
      toolCallId: call.id,
      name: call.name,
      ok: false,
      durationMs: 0,
      args: call.args,
      error: {
        code: "diagnostic_target_gate_blocked",
        message:
          `Latest unresolved diagnostic cites '${target.path}' from '${target.commandOrSource}'. ` +
          "Before broad rebuilds, unrelated edits, installs, or cleanup, either edit/read/check that cited artifact, create/check its direct parent directory when the artifact is missing, or run a narrow command proving it is no longer the failing target. This is a language-agnostic diagnostic targeting rule.",
      },
    });
  }
  return { allowed, blockedResults };
}

function shouldAllowSetupDespiteDiagnosticTarget(command: string, toolResults: ToolResult[]): boolean {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (!isInstallOrUpgradeCommand(normalized)) return false;
  const recentFailureText = toolResults
    .slice(-12)
    .filter((result) => !result.ok)
    .map((result) => `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`)
    .join("\n");
  return /(?:modulenotfounderror|importerror|cannot import|no module named|command not found|not found|missing|requires .*package|cython|setuptools|wheel|pkg-config|compiler|headers?)/i.test(
    recentFailureText,
  );
}

function shouldAllowRuntimeInspectionDespiteDiagnosticTarget(command: string, toolResults: ToolResult[]): boolean {
  if (!isReadOnlyRuntimeInspectionCommand(command)) return false;
  const recentFailureText = toolResults
    .slice(-14)
    .filter((result) => !result.ok)
    .map((result) => `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`)
    .join("\n");
  return /(?:environmentlocationnotfound|not a conda environment|conda environment|virtualenv|venv|modulenotfounderror|importerror|cannot import|no module named|command not found|not found|missing|no such file|shared object|dynamic librar|library not loaded|connection refused|failed to connect|remote end closed|fetch failed|service unavailable|name or service not known|temporary failure in name resolution|dns)/i.test(
    recentFailureText,
  );
}

function isReadOnlyRuntimeInspectionCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (hasShellWriteToLikelyPath(command, isBroadSourceWriteTarget)) return false;
  if (
    /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|install|touch|mkdir|chmod|chown|truncate|ln)\b/i.test(normalized) ||
    /\b(?:pip|pip3|python3?\s+-m\s+pip|npm|pnpm|yarn|bun|cargo|go|apt(?:-get)?|apk|yum|dnf|brew)\s+(?:install|i|add|update|upgrade|remove|uninstall)\b/i.test(
      normalized,
    ) ||
    /\b(?:conda|mamba|micromamba)\s+(?:env\s+)?(?:create|remove|update|install|uninstall|clean)\b/i.test(normalized) ||
    /\bsed\b[^;&|]*\s-i\b/i.test(normalized) ||
    /\btee\b/i.test(normalized)
  ) {
    return false;
  }
  return splitUnquotedShellSegments(command).every((segment) => isReadOnlyRuntimeInspectionSegment(segment));
}

function isReadOnlyRuntimeInspectionSegment(segment: string): boolean {
  const normalized = stripQuotedShellText(segment).replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  if (/\b(?:curl|wget)\b/i.test(normalized) && /\b(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|--data|--data-raw|--data-binary|-d)\b/i.test(normalized)) {
    return false;
  }
  if (
    /\bpython3?\s+-c\b/i.test(normalized) &&
    /\b(?:write_text|write_bytes|unlink|remove|rmtree|rename|replace|subprocess|os\.system|open\s*\([^)]*[,]\s*["']?[wa+])/i.test(segment)
  ) {
    return false;
  }
  return (
    /^(?:cd\s+[^;&|]+\s+)?$/i.test(normalized) ||
    /^echo\b/i.test(normalized) ||
    /^(?:cat|sed\s+-n|head|tail|grep|rg|find|wc)\b/i.test(normalized) ||
    /^(?:ls|test|stat|file|pwd|whoami|id|uname|which|type|command\s+-v)\b/i.test(normalized) ||
    /^(?:env|printenv)\b/i.test(normalized) ||
    /^(?:ps|pgrep|ss|netstat|lsof)\b/i.test(normalized) ||
    /^(?:curl|wget|nc|python3?\s+-c)\b/i.test(normalized) ||
    /^(?:conda|mamba|micromamba)\s+(?:info|list|env\s+list|config\s+--show|run\s+(?:-[A-Za-z0-9-]+\s+\S+\s+)*python(?:3)?\s+(?:-V|--version))\b/i.test(
      normalized,
    )
  );
}

function shouldAllowDependencyManifestRepairDespiteDiagnosticTarget(call: ToolCall, toolResults: ToolResult[]): boolean {
  if (!isDependencyManifestMutation(call)) return false;
  const recentFailureText = toolResults
    .slice(-16)
    .filter((result) => !result.ok)
    .map((result) => `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`)
    .join("\n");
  return /(?:modulenotfounderror|importerror|cannot import|no module named|package|dependency|version|requires|requirement|resolution|resolve|unsatisfiable|conflict|incompatible|conda|mamba|pip|poetry|lockfile|environment\.ya?ml)/i.test(
    recentFailureText,
  );
}

function isDependencyManifestMutation(call: ToolCall): boolean {
  if (!["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(call.name)) return false;
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  return typeof args.path === "string" && isDependencyManifestPath(args.path);
}

function isDiagnosticClearingCheck(call: ToolCall): boolean {
  if (call.name !== "run_shell_command") return false;
  const command = getShellCommandArg(call);
  return isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command);
}

function buildDiagnosticTargetFeedback(blockedResults: ToolResult[]): string[] {
  if (blockedResults.length === 0) return [];
  const details = blockedResults
    .map((result) => `- ${result.name} ${describeToolResultTarget(result)}: ${result.error?.message ?? "blocked"}`)
    .join("\n");
  return [
    [
      "Diagnostic target gate redirected the trajectory.",
      "A recent build/test/runtime failure cited a concrete file. The next high-cost action must focus on that cited artifact, not an unrelated rebuild, dependency action, or legacy cleanup.",
      "Allowed next moves: read the cited file, edit the cited file, run a narrow check that includes the cited file, or gather one missing API/spec detail needed to patch that file.",
      "Blocked actions:",
      details,
    ].join("\n"),
  ];
}

function getUnresolvedDiagnosticTarget(toolResults: ToolResult[]): { path: string; basename: string; relatedPaths: string[]; commandOrSource: string } | undefined {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index]!;
    if (result.ok || result.name !== "run_shell_command") continue;
    if (isInternalGuardBlockedResult(result)) continue;
    const command = getToolResultCommand(result);
    const message = result.error?.message ?? "";
    if (isMissingShellFileOperationSource(command, message)) continue;
    const text = `${command}\n${message}`;
    if (!isBuildCommand(command) && !isTestCommand(command) && !isVerificationLikeCommand(command) && !isCompileOrBuildError(text) && !isRuntimeOrVerificationFailure(result)) {
      continue;
    }
    if (isArchiveExtractionFailure(command, message)) continue;
    if (hasLaterSuccessfulSameClassCheck(command, result, toolResults.slice(index + 1))) continue;
    const candidates = extractFilePathsFromFailure(result)
      .map((item) => stripWorkspacePrefix(normalizeArtifactPathForMatch(item)))
      .filter((item) => item && !isGeneratedOrBuildPath(item) && isActionableDiagnosticPath(item));
    for (const candidate of candidates) {
      if (hasDiagnosticTargetBeenAddressedSince(candidate, command, toolResults.slice(index + 1))) continue;
      return {
        path: candidate,
        basename: path.basename(candidate),
        relatedPaths: uniqueStrings(candidates),
        commandOrSource: command || result.name,
      };
    }
  }
  return undefined;
}

function isInternalGuardBlockedResult(result: ToolResult): boolean {
  const code = result.error?.code ?? "";
  return /(?:_blocked$|policy_block|path_escape|same_batch_|relevance_gate|diagnostic_target_gate|no_progress_loop|repeated_failed_action|repeated_low_information|unsafe_|stale_write|verifier_owned|source_shell_write|synthetic_result)/i.test(
    code,
  );
}

function hasLaterSuccessfulSameClassCheck(failingCommand: string, failingResult: ToolResult, laterResults: ToolResult[]): boolean {
  return laterResults.some((result) => {
    if (!result.ok || result.name !== "run_shell_command") return false;
    if (isSemanticFailedCheckResult(result)) return false;
    const command = getToolResultCommand(result);
    if (isBuildCommand(failingCommand) || isCompileOrBuildError(failingResult.error?.message ?? "")) {
      return isBuildCommand(command);
    }
    if (isTestCommand(failingCommand)) return isTestCommand(command);
    if (isVerificationLikeCommand(failingCommand) || isRuntimeOrVerificationFailure(failingResult)) {
      return isVerificationLikeCommand(command) || isTestCommand(command);
    }
    return false;
  });
}

function isMissingShellFileOperationSource(command: string, message: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (
    /(?:^|[;&|]\s*)(?:mv|cp|rm)\b/i.test(normalized) &&
    /(?:cannot stat|no such file or directory|cannot remove).*?(?:source|file|directory)?/i.test(message)
  );
}

function isArchiveExtractionFailure(command: string, message: string): boolean {
  const text = `${command}\n${message}`;
  const archiveOperation =
    /\b(?:7z|unzip|zip|tar|gzip|gunzip|xz|python3?\s+-m\s+zipfile)\b/i.test(command) ||
    /\b(?:ZipFile|extractall|extract\(|pyzipper|libarchive|patoolib)\b/i.test(command);
  if (!archiveOperation) return false;
  return /(?:wrong password|bad password|incorrect password|password.*(?:wrong|incorrect|failed)|data error|encrypted|unsupported compression|cannot open file as archive|end-of-central-directory signature|not a zip file|crc failed|headers error)/i.test(
    text,
  );
}

function hasDiagnosticTargetBeenAddressedSince(targetPath: string, failingCommand: string, laterResults: ToolResult[]): boolean {
  const target = normalizeArtifactPathForMatch(stripWorkspacePrefix(targetPath));
  const basename = path.basename(target);
  const normalizedFailingCommand = normalizeDiagnosticCommand(failingCommand);
  const failingCwd = extractLeadingCdDirectory(failingCommand);
  for (const result of laterResults) {
    if (result.name === "write_file" || result.name === "replace_in_file" || result.name === "edit_file" || result.name === "replace_symbol" || result.name === "delete_file") {
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      const changedPath = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
      if (result.ok && changedPath && (changedPath === target || path.basename(changedPath) === basename)) return true;
    }
    if (result.ok && result.name === "run_shell_command") {
      const command = getToolResultCommand(result);
      if (command.includes(target) || command.includes(basename)) return true;
      const normalizedCommand = normalizeDiagnosticCommand(command);
      if (normalizedFailingCommand && normalizedCommand === normalizedFailingCommand) return true;
      if (isBuildCommand(command) && isBuildCommand(failingCommand)) return true;
      const commandCwd = extractLeadingCdDirectory(command);
      if (
        isBuildOrVerificationSuccessThatClearsFailure(command, failingCommand) &&
        failingCwd &&
        commandCwd &&
        normalizeArtifactPathForMatch(stripWorkspacePrefix(commandCwd)) === normalizeArtifactPathForMatch(stripWorkspacePrefix(failingCwd))
      ) {
        return true;
      }
    }
  }
  return false;
}

function normalizeDiagnosticCommand(command: string): string {
  return command
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+>/g, " >")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLeadingCdDirectory(command: string): string {
  const match = command.match(/^\s*cd\s+(['"]?)([^'";&|]+)\1\s*&&/);
  return match?.[2]?.trim() ?? "";
}

function isBuildOrVerificationSuccessThatClearsFailure(successCommand: string, failingCommand: string): boolean {
  return (
    (isBuildCommand(successCommand) && isBuildCommand(failingCommand)) ||
    (isTestCommand(successCommand) && isTestCommand(failingCommand)) ||
    (isVerificationLikeCommand(successCommand) && isVerificationLikeCommand(failingCommand))
  );
}

function toolCallTouchesDiagnosticTarget(call: ToolCall, target: { path: string; basename: string; relatedPaths?: string[] }): boolean {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const pathArg = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
  const relatedPaths = target.relatedPaths?.length ? target.relatedPaths : [target.path];
  if (
    pathArg &&
    relatedPaths.some((relatedPath) => {
      const normalizedRelated = normalizeArtifactPathForMatch(stripWorkspacePrefix(relatedPath));
      return pathArg === normalizedRelated || path.basename(pathArg) === path.basename(normalizedRelated);
    })
  ) {
    return true;
  }
  if (call.name === "run_shell_command") {
    const command = getShellCommandArg(call);
    return relatedPaths.some((relatedPath) => {
      const normalizedRelated = normalizeArtifactPathForMatch(stripWorkspacePrefix(relatedPath));
      return command.includes(normalizedRelated) || command.includes(path.basename(normalizedRelated));
    });
  }
  return false;
}

function toolCallPreparesDiagnosticTargetParent(call: ToolCall, target: { path: string; relatedPaths?: string[] }): boolean {
  if (call.name !== "run_shell_command") return false;
  const command = getShellCommandArg(call);
  const relatedPaths = target.relatedPaths?.length ? target.relatedPaths : [target.path];
  return relatedPaths.some((relatedPath) => {
    const normalizedRelated = normalizeArtifactPathForMatch(stripWorkspacePrefix(relatedPath));
    const parent = path.posix.dirname(normalizedRelated);
    if (!parent || parent === "." || parent === "/") return false;
    return shellCommandCreatesOrChecksDirectory(command, parent);
  });
}

function shellCommandCreatesOrChecksDirectory(command: string, relativeDirectory: string): boolean {
  const normalizedDirectory = normalizeArtifactPathForMatch(stripWorkspacePrefix(relativeDirectory)).replace(/\/+$/, "");
  if (!normalizedDirectory) return false;
  const directoryPattern = escapeRegExp(normalizedDirectory).replace(/\\\//g, String.raw`[/\\]+`);
  const withOptionalAppPrefix = String.raw`(?:(?:/app|\.|)\s*[/\\]+)?${directoryPattern}(?:[/\\]+)?`;
  const normalizedCommand = command.replace(/\\\n/g, " ");
  return new RegExp(String.raw`\bmkdir\b[^;&|]*\s(?:-[A-Za-z]*p[A-Za-z]*\s+)?["']?${withOptionalAppPrefix}["']?(?:\s|$|[;&|)])`, "i").test(normalizedCommand) ||
    new RegExp(String.raw`\binstall\b[^;&|]*\s-d\b[^;&|]*\s["']?${withOptionalAppPrefix}["']?(?:\s|$|[;&|)])`, "i").test(normalizedCommand) ||
    new RegExp(String.raw`\b(?:test\s+-d|ls\s+-la|ls\s+-l|ls|find)\s+["']?${withOptionalAppPrefix}["']?(?:\s|$|[;&|)])`, "i").test(normalizedCommand);
}

function isCheapDiagnosticInspection(call: ToolCall): boolean {
  return ["read_file", "view_file", "grep_search", "skim_file", "list_directory", "inspect_environment", "get_tool_output"].includes(call.name);
}

function isExpensiveOrMutatingFollowup(call: ToolCall): boolean {
  return isMutatingToolCall(call) || call.name === "run_shell_command";
}

function isActionableDiagnosticPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/tmp/")) return false;
  if (isGeneratedOrBuildPath(normalized)) return false;
  if (isExternalRuntimeLibraryPath(normalized)) return false;
  if (isToolchainOrDependencyDiagnosticPath(normalized)) return false;
  if (/(?:^|\/)(?:Makefile|build\.make|CMakeCache\.txt|cmake_install\.cmake|rules\.ninja)$/i.test(normalized)) return false;
  if (/\.(?:o|obj|a|so|dll|dylib|exe|class|pyc|pyo|map|log|d|ninja)$/i.test(normalized)) return false;
  if (/\.(?:mdf|bin|dat|csv|tsv|png|jpe?g|gif|webp|pdf|zip|gz|tar|7z|mp[34]|wav|ogg)$/i.test(normalized)) return false;
  if (!normalized.includes("/") && !isSourceLikePath(normalized) && !isProjectConfigPath(normalized)) return false;
  return isSourceLikePath(normalized) || isProjectConfigPath(normalized) || /\.(?:json|ya?ml|toml|ini|cfg|conf|txt|md)$/i.test(normalized);
}

function renderCompilerDiagnosticGuidance(toolResults: ToolResult[]): string {
  const latest = [...toolResults].reverse().find((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
    return isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(text);
  });
  if (!latest) return "# Latest Compiler Diagnostic Guidance\nnone";
  const command = getToolResultCommand(latest);
  const message = latest.error?.message ?? "";
  const diagnosticLines = extractPrimaryDiagnosticLines(message);
  const suggestionLines = extractCompilerSuggestionLines(message);
  return [
    "# Latest Compiler Diagnostic Guidance",
    `Command: ${command || "(unknown)"}`,
    diagnosticLines.length ? `Primary diagnostics:\n${diagnosticLines.map((line) => `- ${line}`).join("\n")}` : "Primary diagnostics: unavailable",
    suggestionLines.length ? `Compiler suggestions:\n${suggestionLines.map((line) => `- ${line}`).join("\n")}` : "Compiler suggestions: none",
    "Repair rules:",
    "- Fix the first real error before warnings or cleanup.",
    "- If the compiler suggests an include/import/module/header, apply that exact targeted fix before reverting unrelated code.",
    "- Do not revert to code that already produced the same error; compare against the latest diagnostic and make a materially different focused repair.",
    "- If the latest errors are brace/scope/parser errors after an edit, read a small range around the first cited line and replace the complete enclosing block with syntactically valid code, then rerun the same narrow build/check.",
  ].join("\n");
}

function renderApiMismatchRecoveryGuidance(toolResults: ToolResult[]): string {
  const latest = [...toolResults].reverse().find((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    return hasApiMismatchDiagnostic(`${getToolResultCommand(result)}\n${result.error?.message ?? ""}`);
  });
  if (!latest) return "# API Mismatch Recovery\nnone";
  const message = latest.error?.message ?? "";
  const missingSymbols = extractApiMismatchSymbols(message);
  const sourceFiles = extractDiagnosticSourceFiles(message);
  return [
    "# API Mismatch Recovery",
    "The latest build failed because generated or edited code called APIs, fields, operators, imports, modules, or symbols that the actual codebase does not expose.",
    missingSymbols.length ? `Missing or mismatched symbols:\n${missingSymbols.map((symbol) => `- ${symbol}`).join("\n")}` : "Missing or mismatched symbols: see primary diagnostics.",
    sourceFiles.length ? `Cited files:\n${sourceFiles.map((filePath) => `- ${filePath}`).join("\n")}` : "Cited files: unavailable",
    "Required next behavior:",
    "- Do not guess replacement APIs or keep expanding the generated source.",
    "- Inspect the actual declarations/exports/schema/types around the cited symbols first using grep_search or bounded read_file.",
    "- Patch only the adapter/call site or smallest declaration-compatible region.",
    "- Prefer a minimal compiling adapter/skeleton before adding more behavior.",
    "- Rerun the same narrow build/typecheck/runtime command that produced the diagnostic.",
    "- Treat compiler suggestions such as 'did you mean' as leads to inspect, not as proof that argument shape/order is compatible.",
    "This rule is language-agnostic: apply it to C/C++, Python, JavaScript/TypeScript, Go, Rust, Java, schemas, configs, and generated code.",
  ].join("\n");
}

function extractPrimaryDiagnosticLines(message: string): string[] {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnostics = lines.filter((line) =>
    /(?:^|[:\s])(?:fatal error|error|undefined reference|cannot find|no such file|not found|expected|does not name a type|was not declared|has no member|no member named|SyntaxError|TypeError|ReferenceError)[:\s]/i.test(line),
  );
  return uniqueStrings(diagnostics).slice(0, 8);
}

function extractCompilerSuggestionLines(message: string): string[] {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const suggestions = lines.filter((line) =>
    /(?:did you forget|did you mean|note: .*defined in header|help:|suggestion:|try|consider)/i.test(line),
  );
  return uniqueStrings(suggestions).slice(0, 6);
}

function hasApiMismatchDiagnostic(message: string): boolean {
  return /(?:has no member|no member named|no match for|was not declared in this scope|does not name a type|cannot convert|undefined reference|is not a function|is not callable|Property .* does not exist|TS2339|TS2304|AttributeError|NameError|ImportError|ModuleNotFoundError|cannot find symbol|method .* cannot be applied|unresolved import|unresolved name)/i.test(
    message,
  );
}

function extractApiMismatchSymbols(message: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /(?:has no member named|has no member|no member named)\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?/gi,
    /['"`]([A-Za-z_][\w:$.-]*)['"`]\s+was not declared in this scope/gi,
    /undefined reference to\s+['"`]?([^'"`\n]+)['"`]?/gi,
    /no match for\s+['"`]?([^'"`\n]+)['"`]?/gi,
    /Property\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?\s+does not exist/gi,
    /AttributeError:\s+[^:\n]+ has no attribute\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?/gi,
    /NameError:\s+name\s+['"`]?([A-Za-z_][\w:$.-]*)['"`]?\s+is not defined/gi,
    /cannot find symbol\s+(?:symbol:\s*)?(?:method|variable|class)?\s*([A-Za-z_][\w:$.-]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const symbol = match[1]?.trim();
      if (symbol) symbols.push(symbol);
    }
  }
  return uniqueStrings(symbols).slice(0, 12);
}

function extractDiagnosticSourceFiles(message: string): string[] {
  const files: string[] = [];
  const patterns = [
    /(?:^|\n)(\/?[A-Za-z0-9_./-]+\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|java|kt|go|rs|py|rb|php|js|jsx|ts|tsx|mjs|cjs|vue|svelte|swift|scala|cs|json|ya?ml|toml)):\d+(?::\d+)?/g,
    /(?:File\s+["'])([^"'\n]+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|php|cs))["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const filePath = match[1]?.trim();
      if (filePath) files.push(filePath);
    }
  }
  return uniqueStrings(files.map((filePath) => stripWorkspacePrefix(filePath))).slice(0, 8);
}

function shouldBlockOverpatchedSourceFile(call: ToolCall, previousResults: ToolResult[]): boolean {
  const callArgs = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const targetPath = typeof callArgs.path === "string" ? callArgs.path : "";
  if (!targetPath || !isSourceLikePath(targetPath)) return false;
  if (call.name === "replace_in_file" && hasLineRangeReplacement(callArgs) && hasRecentReadOfPath(targetPath, previousResults)) return false;
  const recent = previousResults.slice(-80);
  const buildFailures = recent.filter((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
    return (isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(text)) && text.includes(path.basename(targetPath));
  });
  if (buildFailures.length < 4) return false;
  const mutationsOnPath = recent.filter((result) => {
    if (!["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    return args.path === targetPath;
  });
  return mutationsOnPath.length >= 10;
}

function shouldUseSimplifyRecovery(previousResults: ToolResult[]): boolean {
  const recent = previousResults.slice(-100);
  if (recent.some((result) => !result.ok && result.error?.code === "overpatched_source_file_blocked")) return true;
  const recentRuntimeCrash = recent.some((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
    return /(?:code 139|segmentation fault|segfault|core dumped|access violation|bus error)/i.test(text);
  });
  if (recentRuntimeCrash) {
    const recentMutations = recent.filter((result) => ["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(result.name)).length;
    const recentBuildOrValidationFailures = recent.filter((result) => {
      if (result.ok || result.name !== "run_shell_command") return false;
      const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
      return isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(text) || /(?:test|pytest|validate|check|lint|build|run)/i.test(text);
    }).length;
    if (recentMutations >= 4 || recentBuildOrValidationFailures >= 2) return true;
  }
  const sourceMutations = new Map<string, number>();
  const sourceBuildFailures = new Map<string, number>();
  for (const result of recent) {
    if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) {
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      const filePath = typeof args.path === "string" ? args.path : "";
      if (filePath && isSourceLikePath(filePath)) sourceMutations.set(filePath, (sourceMutations.get(filePath) ?? 0) + 1);
    }
    if (!result.ok && result.name === "run_shell_command") {
      const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
      if (!isBuildCommand(getToolResultCommand(result)) && !isCompileOrBuildError(text)) continue;
      for (const filePath of sourceMutations.keys()) {
        if (text.includes(path.basename(filePath))) {
          sourceBuildFailures.set(filePath, (sourceBuildFailures.get(filePath) ?? 0) + 1);
        }
      }
    }
  }
  for (const [filePath, mutationCount] of sourceMutations) {
    if (mutationCount >= 5 && (sourceBuildFailures.get(filePath) ?? 0) >= 2) return true;
  }
  const trailingWriteOnly = recent
    .slice(-18)
    .filter((result) => ["write_file", "replace_in_file", "edit_file"].includes(result.name) || result.name === "read_file");
  const writeCount = trailingWriteOnly.filter((result) => ["write_file", "replace_in_file", "edit_file"].includes(result.name)).length;
  const checkCount = recent.slice(-18).filter((result) => result.name === "run_shell_command").length;
  return writeCount >= 8 && checkCount <= 2;
}

function getOverpatchedBlockedPaths(previousResults: ToolResult[]): string[] {
  const paths = new Set<string>();
  for (const result of previousResults.slice(-100)) {
    if (result.error?.code === "overpatched_source_file_blocked") {
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      const filePath = typeof args.path === "string" ? args.path : "";
      if (filePath) paths.add(filePath);
    }
  }
  return [...paths].slice(0, 8);
}

function shouldBlockRepeatedExactReplace(call: ToolCall, previousResults: ToolResult[]): boolean {
  if (call.name !== "replace_in_file") return false;
  if (!("oldString" in call.args) || typeof call.args.oldString !== "string") return false;
  if (hasLineRangeReplacement(call.args as Record<string, unknown>)) return false;
  const targetPath = typeof call.args.path === "string" ? call.args.path : "";
  if (!targetPath) return false;
  const oldString = call.args.oldString;
  const failedOnPath = previousResults.slice(-12).filter((result) => {
    if (result.ok || result.name !== "replace_in_file") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    if (args.path !== targetPath) return false;
    if (args.oldString !== oldString) return false;
    return /String not found|Multiple matches|exact replacement/i.test(result.error?.message ?? "");
  });
  return failedOnPath.length >= 2;
}

function hasLineRangeReplacement(args: Record<string, unknown>): boolean {
  return Number.isFinite(args.startLine) && Number.isFinite(args.endLine);
}

function hasRecentReadOfPath(targetPath: string, previousResults: ToolResult[]): boolean {
  const normalizedTarget = normalizeArtifactPathForMatch(stripWorkspacePrefix(targetPath));
  return previousResults.slice(-20).some((result) => {
    if (!result.ok || result.name !== "read_file") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const readPath = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
    return readPath === normalizedTarget || path.basename(readPath) === path.basename(normalizedTarget);
  });
}

function hasMutationInCurrentBatch(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((toolCall) => isMutatingToolCall(toolCall));
}

function shouldBlockSourceDeletionShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\brm\s+(?:-[A-Za-z]*\s+)*[^;&|]+/.test(normalized)) return false;
  const rmTargets = extractRmTargets(normalized);
  if (isCMakeGeneratedArtifactCleanup(rmTargets)) return false;
  const sourceLikePaths = rmTargets.filter((target) => {
    const clean = target.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
    if (!clean || clean.startsWith("-")) return false;
    if (/(^|\/)(build|dist|coverage|node_modules|\.git|\.cache|\.next|target|out|tmp|temp)(\/|$)/i.test(clean)) return false;
    return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh|json|toml|ya?ml|xml|cmake|txt)$/i.test(clean) ||
      /(?:^|\/)(CMakeLists\.txt|Makefile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(clean);
  });
  return sourceLikePaths.length > 0;
}

function isCMakeGeneratedArtifactCleanup(targets: string[]): boolean {
  const cleanTargets = targets
    .map((target) => target.replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""))
    .filter((target) => target && !target.startsWith("-"));
  if (cleanTargets.length === 0) return false;
  return cleanTargets.every((target) =>
    /(^|\/)(CMakeCache\.txt|CMakeFiles|Makefile|cmake_install\.cmake)$/.test(target) ||
    /(^|\/)build(\/|$)/.test(target),
  );
}

function shouldBlockBuildConfigShellWrite(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const writesProjectConfig = /\b(?:printf|echo|cat|tee)\b[\s\S]*(?:>|tee\s+)(?:\.\/)?(?:CMakeLists\.txt|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)\b/i.test(command);
  if (!writesProjectConfig) return false;
  if (/\b(?:mkdir\s+-p\s+|cd\s+)[^;&|]*\bbuild\b/i.test(normalized)) return true;
  if (/(?:^|[;&|]\s*)cd\s+[^;&|]*\bbuild\b[\s\S]*(?:CMakeLists\.txt|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)/i.test(command)) return true;
  return false;
}

function shouldBlockVerifierOwnedShellMutation(command: string): boolean {
  const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ");
  return (
    /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|install|touch|mkdir|chmod|chown|truncate)\b[^;&|]*\s\/(?:tests?|__tests__)(?:\/|\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)sed\b[^;&|]*\s-i\b[^;&|]*\s\/(?:tests?|__tests__)(?:\/|\s|$)/i.test(normalized) ||
    /(?:>|>>)\s*\/(?:tests?|__tests__)(?:\/|$)/i.test(normalized) ||
    /\btee\s+(?:-[A-Za-z]+\s+)*\/(?:tests?|__tests__)(?:\/|\s|$)/i.test(normalized)
  );
}

function shouldBlockSourceShellWrite(command: string): boolean {
  return hasShellWriteToLikelyPath(command, isNarrowSourceWriteTarget);
}

function shouldBlockEmptySourcePlaceholderShellCommand(command: string): boolean {
  return splitUnquotedShellSegments(command).some((segment) => {
    const normalized = segment.replace(/\s+/g, " ").trim();
    return (
      /(?:^|\s):\s*>\s*[^;&|]*(?:\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|sh|json|ya?ml|toml)\b)/i.test(normalized) ||
      /(?:^|\s)>\s*[^;&|]*(?:\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|sh|json|ya?ml|toml)\b)/i.test(normalized) ||
      /\btouch\b[^;&|]*(?:\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cc|cpp|h|hpp|sh|json|ya?ml|toml)\b)/i.test(normalized)
    );
  });
}

function hasShellWriteToLikelyPath(command: string, isTargetPath: (target: string) => boolean): boolean {
  return splitUnquotedShellSegments(command).some(
    (segment) =>
      (hasUnquotedCommandWord(segment, ["cat", "printf", "echo"]) && hasUnquotedRedirectToLikelyPath(segment, isTargetPath)) ||
      hasUnquotedTeeToLikelyPath(segment, isTargetPath),
  );
}

function shouldBlockSyntheticResultOrMockService(command: string, summary: string): boolean {
  const text = `${summary}\n${command}`;
  const normalized = text.replace(/\s+/g, " ");
  const syntheticSignal =
    /\b(?:mock|fake|dummy|placeholder|hardcoded?|stub(?:bed)?|synthetic|forged|fabricat(?:e|ed|ion))\b/i.test(normalized) ||
    /\b(?:SECRET_MESSAGE|SUCCESS_MESSAGE|TASK_COMPLETE|ALL_TESTS_PASS|decrypted:\s*[^;&|]*->)\b/i.test(normalized);
  if (!syntheticSignal) return false;

  const startsService =
    /\b(?:http\.server|BaseHTTPRequestHandler|socketserver|express\s*\(|createServer\s*\(|Flask\s*\(|FastAPI\s*\(|uvicorn|python3?\s+-m\s+http\.server|nc\s+-l|socat)\b/i.test(
      normalized,
    );
  const writesLikelyFinalArtifact =
    /(?:>|>>|\btee\s+|-o\s+|open\s*\(|writeFileSync\s*\(|writeFile\s*\()[^;&|]*(?:result|results|answer|output|final|solution|flag|message)[^;&|]{0,80}/i.test(
      normalized,
    );
  const mentionsLikelyFinalArtifact = /\b(?:results?\.txt|answer\.(?:txt|json)|output\.(?:txt|json|csv)|final[_-]?message|solution\.(?:txt|json)|flag\.txt)\b/i.test(
    normalized,
  );
  const generatedServiceResponse =
    startsService &&
    /\b(?:serve_forever|listen\s*\(|app\.run\s*\(|uvicorn\.run|wfile\.write|res\.json|send_response|json\.dumps)\b/i.test(normalized) &&
    /\b(?:result|results|answer|output|final|solution|flag|message|success|ready|secret)\b/i.test(normalized);

  return (syntheticSignal && (startsService || writesLikelyFinalArtifact || mentionsLikelyFinalArtifact)) || generatedServiceResponse;
}

function shouldBlockSyntheticServiceFileMutation(call: ToolCall): boolean {
  if (!["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(call.name)) return false;
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const pathArg = typeof args.path === "string" ? args.path : "";
  const content = [args.content, args.newString, args.newCode]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
  if (!content) return false;
  const normalized = `${pathArg}\n${content}`.replace(/\s+/g, " ");
  const startsService = /\b(?:http\.server|BaseHTTPRequestHandler|socketserver|express\s*\(|createServer\s*\(|Flask\s*\(|FastAPI\s*\(|uvicorn|serve_forever|listen\s*\(|app\.run\s*\()\b/i.test(
    normalized,
  );
  if (!startsService) return false;
  const writesLikelyFinalArtifact =
    /(?:open\s*\(|writeFileSync\s*\(|writeFile\s*\()[^;&|]{0,120}\b(?:results?\.txt|answer\.(?:txt|json)|output\.(?:txt|json|csv)|solution\.(?:txt|json)|flag\.txt)\b/i.test(
      normalized,
    );
  const hardcodedFinalResponse =
    /\b(?:result|message|answer|flag|secret)\s*=\s*f?["'`][^"'`]*(?:decrypted|success|revealed|secret|flag|answer|ready)[^"'`]*["'`]/i.test(
      normalized,
    ) || /\b(?:wfile\.write|res\.json|json\.dumps)\s*\([^)]*(?:decrypted|success|revealed|secret|flag|answer|ready)/i.test(normalized);
  return writesLikelyFinalArtifact || hardcodedFinalResponse;
}

function shouldBlockCombinedSourceMutationAndCheck(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (!hasSourceMutationShellFragment(normalized)) return false;
  if (isFocusedInPlaceShellEditThenCheck(normalized)) return false;
  return hasVerificationShellFragment(normalized);
}

function isFocusedInPlaceShellEditThenCheck(command: string): boolean {
  if (!hasVerificationShellFragment(command)) return false;
  if (hasShellWriteToLikelyPath(command, isBroadSourceWriteTarget)) return false;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade)|\bpip\s+install\b|\bcargo\s+add\b|\bgo\s+get\b/i.test(command)) return false;
  if (/\b(?:git\s+(?:reset|clean|checkout)|rm\s+-rf\s+(?![^;&|]*(?:build|dist|coverage|target|out|\.cache|CMakeFiles|\/tmp\/)))/i.test(command)) return false;
  const editFragments = command
    .split(/\s*(?:&&|;)\s*/)
    .filter((fragment) => /\b(?:sed|perl|python|python3|ruby|node|awk)\b/i.test(fragment) && /(?:-i|write|replace|rename)/i.test(fragment));
  if (editFragments.length === 0 || editFragments.length > 4) return false;
  return editFragments.every((fragment) =>
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh|json|toml|ya?ml|xml|cmake|txt)\b|(?:CMakeLists\.txt|Makefile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)\b/i.test(fragment),
  );
}

function hasSourceMutationShellFragment(command: string): boolean {
  const sourcePath = String.raw`[^;&|]*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh|json|toml|ya?ml|xml|cmake|txt)|[^;&|]*(?:CMakeLists\.txt|Makefile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)`;
  const unquoted = stripQuotedShellText(command);
  const shellWrite = new RegExp(String.raw`\b(?:sed|perl|python|python3|ruby|node|awk)\b[^;&|]*(?:-i|write|replace|truncate|rename)[^;&|]*(?:${sourcePath})`, "i");
  return shellWrite.test(unquoted) || hasShellWriteToLikelyPath(command, isBroadSourceWriteTarget);
}

function hasVerificationShellFragment(command: string): boolean {
  return /\b(?:cmake|make|gmake|ninja|npm\s+(?:test|run\s+(?:test|build|lint|check))|pnpm\s+(?:test|run\s+(?:test|build|lint|check))|yarn\s+(?:test|run\s+(?:test|build|lint|check))|bun\s+(?:test|run\s+(?:test|build|lint|check))|pytest|python\s+-m\s+pytest|cargo\s+(?:test|build|check)|go\s+test|mvn\s+test|gradle\s+test|ctest)\b/.test(command);
}

function isNarrowSourceWriteTarget(target: string): boolean {
  return isLikelyShellPath(target, /(?:^|\/)[^;&|]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh)$/i);
}

function isBroadSourceWriteTarget(target: string): boolean {
  return isLikelyShellPath(
    target,
    /(?:^|\/)[^;&|]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh|json|toml|ya?ml|xml|cmake|txt)$/i,
  ) || /(?:^|\/)(?:CMakeLists\.txt|Makefile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(cleanShellWord(target));
}

function isLikelyShellPath(target: string, pattern: RegExp): boolean {
  const clean = cleanShellWord(target);
  if (!clean || clean.startsWith("-") || clean.startsWith("&")) return false;
  if (/^[A-Za-z]+:\/\//.test(clean)) return false;
  return pattern.test(clean);
}

function cleanShellWord(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, "");
}

function hasUnquotedCommandWord(segment: string, commands: string[]): boolean {
  const visible = stripQuotedShellText(segment);
  return commands.some((command) => new RegExp(String.raw`(?:^|[\s({])${escapeRegExp(command)}(?:$|[\s)}])`, "i").test(visible));
}

function hasUnquotedRedirectToLikelyPath(segment: string, isTargetPath: (target: string) => boolean): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    const previous = segment[index - 1] ?? "";
    const next = segment[index + 1] ?? "";
    if (previous === "-" || previous === "=" || previous === "<" || previous === ">" || next === "=") continue;
    const operatorLength = next === ">" ? 2 : 1;
    const target = readShellWord(segment, index + operatorLength);
    if (isTargetPath(target)) return true;
  }
  return false;
}

function hasUnquotedTeeToLikelyPath(segment: string, isTargetPath: (target: string) => boolean): boolean {
  const words = parseShellWords(segment);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index]?.toLowerCase() !== "tee") continue;
    for (let targetIndex = index + 1; targetIndex < words.length; targetIndex += 1) {
      const target = words[targetIndex] ?? "";
      if (target.startsWith("-")) continue;
      if (isTargetPath(target)) return true;
      break;
    }
  }
  return false;
}

function splitUnquotedShellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || (char === "&" && command[index + 1] === "&")) {
      const segment = command.slice(start, index).trim();
      if (segment) segments.push(segment);
      if ((char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) index += 1;
      start = index + 1;
    }
  }
  const finalSegment = command.slice(start).trim();
  if (finalSegment) segments.push(finalSegment);
  return segments;
}

function stripQuotedShellText(command: string): string {
  let output = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of command) {
    if (quote) {
      output += char === "\n" ? "\n" : " ";
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function readShellWord(input: string, start: number): string {
  let index = start;
  while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  for (; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>()]/.test(char)) break;
    word += char;
  }
  return word;
}

function parseShellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  const pushWord = () => {
    if (word) words.push(word);
    word = "";
  };
  for (const char of input) {
    if (quote) {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>()]/.test(char)) {
      pushWord();
      continue;
    }
    word += char;
  }
  pushWord();
  return words;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guardRepeatedReadOnlyBatch(
  toolCalls: ToolCall[],
  split: SplitToolCalls,
  previousBatchSignatures: string[],
  previousResults: ToolResult[],
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  if (toolCalls.length === 0 || split.advancementSignal || split.completionSignal) {
    return { allowed: toolCalls, blockedResults: [] };
  }
  const signature = makeReadOnlyBatchSignature(toolCalls);
  if (!signature) return { allowed: toolCalls, blockedResults: [] };
  const repeatedCount = countTrailing(previousBatchSignatures, signature);
  if (repeatedCount < 2) return { allowed: toolCalls, blockedResults: [] };
  if (isRecentDiagnosticTargetReadBatch(toolCalls, previousResults)) {
    return { allowed: toolCalls, blockedResults: [] };
  }
  return {
    allowed: [],
    blockedResults: toolCalls.map((call) => ({
      toolCallId: call.id,
      name: call.name,
      ok: false,
      durationMs: 0,
      args: call.args,
      error: {
        code: "repeated_read_only_batch_blocked",
        message:
          `Reaper blocked repeated read-only batch '${signature}' after ${repeatedCount} prior identical batches without progress. ` +
          "Do not reread the same files/directories. Use the already observed context to make a concrete edit/check, inspect different evidence, emit advance_step with evidence, call an advisory subagent, or replan.",
      },
    })),
  };
}

function guardImplementationReadOnlyDrift(
  toolCalls: ToolCall[],
  split: SplitToolCalls,
  step: ExecutionPlanStep | undefined,
  previousBatchSignatures: string[],
  previousResults: ToolResult[],
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  if (!step || !isImplementationLikeStep(step)) return { allowed: toolCalls, blockedResults: [] };
  if (toolCalls.length === 0 || split.advancementSignal || split.completionSignal) {
    return { allowed: toolCalls, blockedResults: [] };
  }
  const signature = makeReadOnlyBatchSignature(toolCalls);
  if (!signature) return { allowed: toolCalls, blockedResults: [] };
  const readOnlySinceImplementationFailure = countReadOnlyBatchesSinceLastImplementationFailure(previousResults);
  if (readOnlySinceImplementationFailure < 3) {
    if (previousBatchSignatures.length < 8) return { allowed: toolCalls, blockedResults: [] };
    if (isSmallFocusedReadOnlyBatch(toolCalls)) return { allowed: toolCalls, blockedResults: [] };
  }
  return {
    allowed: [],
    blockedResults: toolCalls.map((call) => ({
      toolCallId: call.id,
      name: call.name,
      ok: false,
      durationMs: 0,
      args: call.args,
      error: {
        code: "implementation_read_only_drift_blocked",
        message:
          `Reaper blocked another read-only batch on implementation step '${step.id}' after multiple successful inspections. ` +
          "Use the already observed context and the latest build/runtime failure to create/edit the required artifact, run a concrete check, emit advance_step with evidence if done, or request a smaller replan. Do not keep reading different combinations of the same context.",
      },
    })),
  };
}

function countReadOnlyBatchesSinceLastImplementationFailure(results: ToolResult[]): number {
  let count = 0;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result) continue;
    if (isMutationOrProducerResult(result)) return 0;
    if (isReadOnlyToolResult(result)) {
      count += 1;
      continue;
    }
    if (!result.ok && result.name === "run_shell_command") {
      const command = getToolResultCommand(result);
      if (isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command) || isBuildArtifactRuntimeCommand(command)) {
        return count;
      }
    }
  }
  return 0;
}

export function isReadOnlyToolResult(result: ToolResult): boolean {
  return ["read_file", "view_file", "list_directory", "grep_search", "skim_file", "inspect_env", "web_search", "web_fetch", "get_tool_output"].includes(result.name);
}

function isMutationOrProducerResult(result: ToolResult): boolean {
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "task_create", "task_update"].includes(result.name)) return true;
  if (result.name !== "run_shell_command") return false;
  const command = getToolResultCommand(result);
  return isMutatingShellCommand(command) || isProducerOrVerificationCommand(command);
}

function isSmallFocusedReadOnlyBatch(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length > 8) return false;
  return toolCalls.every((call) => {
    if (call.name === "read_file" || call.name === "view_file") {
      const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
      const pathArg = typeof args.path === "string" ? args.path : "";
      return Boolean(pathArg) && !isGeneratedOrBuildPath(pathArg);
    }
    if (call.name === "grep_search") return true;
    return false;
  });
}

function isRecentDiagnosticTargetReadBatch(toolCalls: ToolCall[], previousResults: ToolResult[]): boolean {
  if (!toolCalls.length || !toolCalls.every((call) => call.name === "read_file" || call.name === "view_file")) return false;
  const latestFailure = [...previousResults].reverse().find((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    const command = getToolResultCommand(result);
    const message = result.error?.message ?? "";
    return isBuildCommand(command) || isTestCommand(command) || isVerificationLikeCommand(command) || isCompileOrBuildError(message);
  });
  if (!latestFailure) return false;
  const targets = extractFilePathsFromFailure(latestFailure)
    .map((item) => normalizeArtifactPathForMatch(stripWorkspacePrefix(item)))
    .filter((item) => item && isActionableDiagnosticPath(item));
  if (targets.length === 0) return false;
  return toolCalls.every((call) => {
    const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
    const readPath = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
    return readPath && targets.some((target) => readPath === target || path.basename(readPath) === path.basename(target));
  });
}

function updateReadOnlyBatchSignatures(input: {
  previous: string[];
  split?: SplitToolCalls | undefined;
  lastBatchFailed: boolean;
}): string[] {
  const split = input.split;
  if (!split || split.advancementSignal || split.completionSignal) return [];
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

export function getShellCommandArg(call: ToolCall): string {
  return call.name === "run_shell_command" && typeof call.args.cmd === "string" ? call.args.cmd : "";
}

function getShellSummaryArg(call: ToolCall): string {
  return call.name === "run_shell_command" && typeof call.args.summary === "string" ? call.args.summary : "";
}

function guardMissingArtifactValidationBeforeProducer(
  toolCalls: ToolCall[],
  previousResults: ToolResult[],
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  const facts = deriveRuntimeBlockingFacts(previousResults);
  if (facts.missingArtifacts.length === 0 || facts.successfulProducerOrVerificationAfterBlocker) {
    return { allowed: toolCalls, blockedResults: [] };
  }
  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const producedInBatch = new Set<string>();
  for (const call of toolCalls) {
    const unresolvedMissingArtifacts = facts.missingArtifacts.filter(
      (artifact) => !producedInBatch.has(normalizeArtifactPathForMatch(stripWorkspacePrefix(artifact))),
    );
    if (
      unresolvedMissingArtifacts.length > 0 &&
      ((call.name === "run_shell_command" && isValidationOfMissingArtifacts(getShellCommandArg(call), unresolvedMissingArtifacts)) ||
        (call.name === "read_file" && isReadOfMissingArtifact(call, unresolvedMissingArtifacts)))
    ) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "missing_artifact_validation_blocked",
          message:
            `Reaper blocked validation of missing artifact(s): ${facts.missingArtifacts.slice(0, 5).join(", ")}. ` +
            "Do not validate/read outputs before a producer command has successfully created them. Fix the build/runtime producer first, run it successfully, then validate the artifacts.",
        },
      });
      continue;
    }
    addProducedMissingArtifactsFromToolCall(call, facts.missingArtifacts, producedInBatch);
    allowed.push(call);
  }
  return { allowed, blockedResults };
}

function addProducedMissingArtifactsFromToolCall(call: ToolCall, missingArtifacts: string[], producedInBatch: Set<string>): void {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const producedPaths: string[] = [];
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(call.name) && typeof args.path === "string") {
    producedPaths.push(args.path);
  } else if (call.name === "sandbox_service_control" && typeof args.targetPath === "string") {
    producedPaths.push(args.targetPath);
  }
  for (const producedPath of producedPaths) {
    const normalizedProduced = normalizeArtifactPathForMatch(stripWorkspacePrefix(producedPath));
    if (!normalizedProduced) continue;
    for (const artifact of missingArtifacts) {
      const normalizedArtifact = normalizeArtifactPathForMatch(stripWorkspacePrefix(artifact));
      if (normalizedArtifact === normalizedProduced) producedInBatch.add(normalizedArtifact);
    }
  }
}
function isReadOfMissingArtifact(call: ToolCall, missingArtifacts: string[]): boolean {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  if (typeof args.path !== "string") return false;
  const readPath = normalizeArtifactPathForMatch(args.path);
  if (!readPath) return false;
  if (isSandboxServiceDiagnosticPath(readPath)) return false;
  return missingArtifacts.some((artifact) => {
    const normalized = normalizeArtifactPathForMatch(stripWorkspacePrefix(artifact));
    return normalized === readPath;
  });
}

function guardSandboxServiceNetworkActions(
  toolCalls: ToolCall[],
  previousResults: ToolResult[],
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  if (!hasSandboxServiceRuntimeContext() || !hasRecentSandboxServiceDnsFailure(previousResults)) {
    return { allowed: toolCalls, blockedResults: [] };
  }
  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  for (const call of toolCalls) {
    const command = call.name === "run_shell_command" ? getShellCommandArg(call) : "";
    if (command && isBareSandboxServiceNetworkProbe(command)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "sandbox_service_network_probe_blocked",
          message:
            "Reaper blocked another task-container network probe to a bare service hostname after DNS/service resolution already failed. " +
            "Do not keep retrying curl/wget/nc from the task container and do not synthesize a mock service. Use sandbox_service_control instead: list services, read logs, snapshot /app, exec inside the real service, repair files with write_file/copy_to_service, restart/start it, then verify through the official/user-facing check.",
        },
      });
      continue;
    }
    allowed.push(call);
  }
  return { allowed, blockedResults };
}

export function buildAutomaticServiceRecoveryCall(
  toolCalls: ToolCall[],
  previousResults: ToolResult[],
  config: Pick<ReaperConfig["runtime"]["serviceSupervisor"], "enabled" | "autoRecover" | "maxAutoRecoveriesPerService" | "readinessTimeoutMs">,
): ToolCall | undefined {
  if (!config.enabled || !config.autoRecover || !hasSandboxServiceRuntimeContext()) return undefined;
  if (toolCalls.some(isSandboxServiceRecoveryAction)) return undefined;
  const priorAutomaticRecoveries = previousResults.filter(
    (result) => result.name === "sandbox_service_control" && result.toolCallId.startsWith("auto-service-recovery-"),
  ).length;
  if (priorAutomaticRecoveries >= config.maxAutoRecoveriesPerService) return undefined;
  const failure = findRecentSandboxServiceRecoveryNeed(previousResults);
  if (!failure) return undefined;

  return ToolCallSchema.parse({
    id: `auto-service-recovery-${priorAutomaticRecoveries + 1}`,
    name: "sandbox_service_control",
    args: {
      action: "wait_ready",
      ...(failure.service ? { service: failure.service } : {}),
      timeoutMs: config.readinessTimeoutMs,
    },
  });
}

function isSandboxServiceRecoveryAction(call: ToolCall): boolean {
  if (call.name !== "sandbox_service_control") return false;
  const action = String((call.args as Record<string, unknown>).action ?? "");
  return ["wait_ready", "restart", "recreate", "start", "write_file", "copy_to_service", "inspect_image", "restore_from_image"].includes(action);
}

function findRecentSandboxServiceRecoveryNeed(results: ToolResult[]): { command: string; service?: string } | undefined {
  for (const result of results.slice(-20).reverse()) {
    if (result.name === "sandbox_service_control" && result.ok) {
      const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
      const services = Array.isArray(output.services) ? output.services : [];
      const failedServices = services.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const service = item as Record<string, unknown>;
        return service.role === "service" && ["crashed", "unhealthy", "stopped", "configured"].includes(String(service.lifecycle ?? ""));
      });
      if (failedServices.length === 1 && typeof failedServices[0]!.name === "string") {
        return { command: "sandbox_service_control list", service: failedServices[0]!.name as string };
      }
    }
    if (result.name !== "run_shell_command") continue;
    const command = getToolResultCommand(result);
    if (!isBareSandboxServiceNetworkProbe(command)) continue;
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined;
    const text = `${getToolResultText(result)}\n${command}`.toLowerCase();
    const failed =
      !result.ok ||
      (exitCode !== undefined && exitCode !== 0) ||
      /could not resolve host|name or service not known|temporary failure in name resolution|connection refused|failed to connect|nameresolutionerror|exit(?:ed)? (?:code|with code) [67]\b/.test(
        text,
      );
    if (!failed) continue;
    const service = extractUrlHosts(command).find((host) => !host.includes(".") && !["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host));
    return { command, ...(service ? { service } : {}) };
  }
  return undefined;
}

function guardCondaRecoveryActions(
  toolCalls: ToolCall[],
  previousResults: ToolResult[],
): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  const state = deriveCondaRecoveryState(previousResults);
  if (!state.hasBlocker) return { allowed: toolCalls, blockedResults: [] };

  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  for (const call of toolCalls) {
    const command = call.name === "run_shell_command" ? getShellCommandArg(call) : "";
    if (!command || !isCondaCommand(command)) {
      allowed.push(call);
      continue;
    }

    const normalized = command.replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();
    let message: string | undefined;

    if (/\bconda\s+env\s+create\b/i.test(normalized) && /\s--force(?:\s|$)/i.test(normalized)) {
      message =
        "Reaper blocked `conda env create --force` because conda env create does not support --force. Remove or update the environment explicitly: inspect env state, delete a broken prefix in a separate successful step if needed, then run `conda env create -f ... -y` or `conda env update ... --prune`.";
    } else if (state.cacheCorrupt && isCondaCreateOrInstallCommand(normalized) && !state.cacheCleanedAfterBlocker && !/\bconda\s+clean\b/i.test(lower)) {
      message =
        "Reaper blocked another conda create/install after conda reported a corrupted package cache. First run a separate cache recovery command such as `conda clean --packages --tarballs -y` or `conda clean -afy`, then remove any broken target prefix, verify it is gone, and only then recreate the environment. Retrying create/install against the same cache is not progress.";
    } else if (state.prefixBroken && isCondaEnvCreateCommand(normalized) && !state.prefixCleanedAfterBlocker && !isCondaPrefixCleanupCommand(normalized)) {
      message =
        "Reaper blocked another `conda env create` because the target prefix is known to already exist or is not a valid conda environment. Clean it in a separate successful command first (`conda env remove -n <name> -y` when valid, or a bounded explicit prefix deletion when corrupt), verify the prefix is absent, then create the environment. Do not combine cleanup and recreate until the cleanup has succeeded.";
    }

    if (message) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "conda_recovery_required",
          message,
        },
      });
      continue;
    }
    allowed.push(call);
  }
  return { allowed, blockedResults };
}

function hasSandboxServiceRuntimeContext(): boolean {
  return Boolean(process.env.REAPER_TBENCH_CONTAINER_NAME?.trim() || process.env.REAPER_TBENCH_COMPOSE_PROJECT?.trim());
}

function hasRecentSandboxServiceDnsFailure(results: ToolResult[]): boolean {
  return results.slice(-20).some((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`.toLowerCase();
    return /could not resolve host|nameresolutionerror|temporary failure in name resolution|failed to resolve|name or service not known/.test(text);
  });
}

function isBareSandboxServiceNetworkProbe(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\b(?:curl|wget|nc|netcat)\b/i.test(normalized)) return false;
  const hosts = extractUrlHosts(normalized);
  return hosts.some((host) => {
    const lower = host.toLowerCase();
    if (lower === "localhost" || lower === "127.0.0.1" || lower === "0.0.0.0" || lower === "::1") return false;
    if (lower.includes(".")) return false;
    return /^[a-z0-9][a-z0-9_-]*$/i.test(host);
  });
}

function extractUrlHosts(command: string): string[] {
  const hosts: string[] = [];
  for (const match of command.matchAll(/\bhttps?:\/\/\[?([A-Za-z0-9_.:-]+)\]?(?::\d+)?(?:[/?#\s]|$)/g)) {
    const host = match[1]?.replace(/^\[/, "").replace(/\]$/, "").split(":")[0];
    if (host) hosts.push(host);
  }
  return uniqueStrings(hosts);
}

function deriveCondaRecoveryState(results: ToolResult[]): {
  hasBlocker: boolean;
  cacheCorrupt: boolean;
  prefixBroken: boolean;
  cacheCleanedAfterBlocker: boolean;
  prefixCleanedAfterBlocker: boolean;
} {
  let blockerIndex = -1;
  let cacheCorrupt = false;
  let prefixBroken = false;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result || result.ok) continue;
    const text = `${getToolResultCommand(result)}\n${result.error?.message ?? ""}`;
    if (/condaverificationerror|safetyerror|appears to be corrupted/i.test(text)) {
      blockerIndex = index;
      cacheCorrupt = true;
      break;
    }
    if (/prefix already exists|directorynotacondaenvironmenterror|environmentlocationnotfound|not a conda environment/i.test(text)) {
      blockerIndex = index;
      prefixBroken = true;
      break;
    }
  }
  if (blockerIndex < 0) {
    return { hasBlocker: false, cacheCorrupt: false, prefixBroken: false, cacheCleanedAfterBlocker: false, prefixCleanedAfterBlocker: false };
  }
  const after = results.slice(blockerIndex + 1).filter((result) => result.ok && result.name === "run_shell_command");
  return {
    hasBlocker: true,
    cacheCorrupt,
    prefixBroken,
    cacheCleanedAfterBlocker: after.some((result) => /\bconda\s+clean\b/i.test(getToolResultCommand(result))),
    prefixCleanedAfterBlocker: after.some((result) => isCondaPrefixCleanupCommand(getToolResultCommand(result))),
  };
}

function isCondaCommand(command: string): boolean {
  return /\b(?:conda|mamba|micromamba)\b/i.test(command);
}

function isCondaCreateOrInstallCommand(command: string): boolean {
  return /\b(?:conda|mamba|micromamba)\s+(?:env\s+(?:create|update)|install|update)\b/i.test(command);
}

function isCondaEnvCreateCommand(command: string): boolean {
  return /\b(?:conda|mamba|micromamba)\s+env\s+create\b/i.test(command);
}

function isCondaPrefixCleanupCommand(command: string): boolean {
  return (
    /\b(?:conda|mamba|micromamba)\s+env\s+remove\b[\s\S]*\s(?:-y|--yes)(?:\s|$)/i.test(command) ||
    /\b(?:rm\s+-rf|shutil\.rmtree)\b[\s\S]*(?:\/envs\/|conda\/envs|\.conda\/envs)/i.test(command)
  );
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
    .filter((result) => !result.ok && ["replace_in_file", "edit_file", "replace_symbol", "write_file"].includes(result.name)).length;
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
  if (result.name !== "run_shell_command") return false;
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

function getCompletionBlocker(results: ToolResult[], runId: string, prompt = "", config?: ReaperConfig): string | undefined {
  reconcileBackfilledRuntimeTasksWithEvidence(runId, results);
  const facts = deriveRuntimeBlockingFacts(results);
  const semanticOutputRecovery = hasSemanticOutputRecovery(results);
  closeClearedBackfilledRuntimeTasks(runId, facts, hasRecentSuccessfulLocalVerification(results), semanticOutputRecovery);
  const openTasks = listSessionTasks(undefined, runId).filter((t) => t.status !== "completed");
  if (openTasks.length > 0) {
    const preview = openTasks.slice(0, 5).map((t) => `[${t.id} ${t.status}] ${t.subject}`).join("; ");
    return `Completion is blocked because the session todo list still has ${openTasks.length} open task(s): ${preview}. Finish them with the relevant tools and mark each completed with task_update, or remove tasks that became irrelevant, before emitting complete_task.`;
  }
  const unresolvedTaskContractCheck = getUnresolvedTaskContractVerificationBlocker(results);
  if (unresolvedTaskContractCheck) return unresolvedTaskContractCheck;
  if (config?.runtime.artifactObligations.enabled !== false) {
    const artifactObligationBlocker = getArtifactObligationBlocker(prompt, results);
    if (artifactObligationBlocker) return artifactObligationBlocker;
  }
  if (config?.verification.contractCoverage.enabled !== false) {
    const contractCoverageBlocker = getContractCoverageBlocker(prompt, results);
    if (contractCoverageBlocker) return contractCoverageBlocker;
  }
  if (semanticOutputRecovery && facts.missingArtifacts.length === 0 && facts.failedBuildOrCompile.length === 0) return undefined;
  if (facts.successfulProducerOrVerificationAfterBlocker) return undefined;
  const recentPlaceholderProducer = [...results]
    .slice(-10)
    .reverse()
    .find((result) => hasPlaceholderShellOutput(result) && isProducerOrVerificationCommand(getToolResultCommand(result)));
  if (recentPlaceholderProducer) {
    return "Completion is blocked because a recent producer/check command succeeded only with placeholder or stub behavior, not real task output.";
  }
  const crossOutputCountBlocker = getCrossOutputCountRegressionBlocker(results);
  if (crossOutputCountBlocker) return crossOutputCountBlocker;
  const blockers = [
    ...facts.missingArtifacts.map((artifact) => `missing artifact '${artifact}'`),
    ...facts.failedBuildOrCompile.map((item) => `build/compile failure '${item}'`),
    ...facts.failedRuntimeOrVerification.map((item) => `runtime/verification failure '${item}'`),
  ].slice(0, 8);
  if (blockers.length) {
    return `Completion is blocked by unresolved runtime facts: ${blockers.join("; ")}.`;
  }
  const unverifiedMutation = getUnverifiedMutationBlocker(results);
  if (unverifiedMutation) return unverifiedMutation;
  return undefined;
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
  if (result.ok || result.name !== "run_shell_command" || isInternalGuardBlockedResult(result)) return false;
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
  if (!result.ok || result.name !== "run_shell_command" || isSemanticFailedCheckResult(result)) return false;
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
    if (result.name !== "run_shell_command" || !result.ok) continue;
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
  if (result.name !== "run_shell_command") return undefined;
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

function isSemanticFailedCheckResult(result: ToolResult): boolean {
  return Boolean(getSemanticFailureSignal(result));
}

function getUnverifiedMutationBlocker(results: ToolResult[]): string | undefined {
  const mutationTools = new Set(["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"]);
  const window = results.slice(-25);
  const lastMutationIdx = findLastIndexCompat(window, (r) => r.ok && mutationTools.has(r.name));
  if (lastMutationIdx < 0) return undefined;
  const afterMutation = window.slice(lastMutationIdx + 1);
  const hasVerifier = afterMutation.some((r) =>
    r.ok && r.name === "run_shell_command" && !isSemanticFailedCheckResult(r) && (
      isBuildCommand(getToolResultCommand(r)) ||
      isTestCommand(getToolResultCommand(r)) ||
      isVerificationLikeCommand(getToolResultCommand(r)) ||
      isProducerOrVerificationCommand(getToolResultCommand(r))
    ),
  );
  if (hasVerifier) return undefined;
  const lastMut = window[lastMutationIdx]!;
  return `Completion is blocked because the most recent successful ${lastMut.name} has no subsequent successful run_shell_command that exercises the deliverable. Run a real verification step: prefer any workspace-provided verifier (tests/, run-tests.*, Makefile target, pytest/npm test/cargo test/etc.) if present; otherwise invoke the produced artifact the way the spec describes it being used. Read the output and cross-check both content (values, counts, structure) and form (exact whitespace, punctuation, casing — any literal template in the spec is byte-exact modulo placeholder substitutions). Only emit complete_task after that real verification succeeds and matches. Self-reports do not count.`;
}

function getPlanStepAdvancementBlocker(input: {
  workspaceRoot: string;
  step: ExecutionPlanStep;
  toolResults: ToolResult[];
}): string | undefined {
  if (isReadOnlyPlanStep(input.step)) {
    return undefined;
  }

  const recentToolResults = input.toolResults.slice(-10);
  const latestFailedMutation = findLastIndexCompat(
    recentToolResults,
    (result) => !result.ok && ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name),
  );
  const latestSuccessfulMutationOrCheck = findLastIndexCompat(
    recentToolResults,
    (result) =>
      result.ok &&
      (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name) ||
        (result.name === "run_shell_command" &&
          !isSemanticFailedCheckResult(result) &&
          (isBuildCommand(getToolResultCommand(result)) || isTestCommand(getToolResultCommand(result)) || isVerificationLikeCommand(getToolResultCommand(result))))),
  );
  if (latestFailedMutation >= 0 && latestSuccessfulMutationOrCheck <= latestFailedMutation) {
    const failed = recentToolResults[latestFailedMutation]!;
    return `recent ${failed.name} failed and there is no later successful edit or build/test/check evidence for this implementation step.`;
  }

  const latestPlaceholderProducer = findLastIndexCompat(
    recentToolResults,
    (result) => hasPlaceholderShellOutput(result) && isProducerOrVerificationCommand(getToolResultCommand(result)),
  );
  const latestUsefulMutationAfterPlaceholder = findLastIndexCompat(
    recentToolResults,
    (result) =>
      result.ok &&
      (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name) ||
        (result.name === "run_shell_command" &&
          isProducerOrVerificationCommand(getToolResultCommand(result)) &&
          !isSemanticFailedCheckResult(result) &&
          !hasPlaceholderShellOutput(result))),
  );
  if (latestPlaceholderProducer >= 0 && latestUsefulMutationAfterPlaceholder <= latestPlaceholderProducer) {
    return "recent producer/check command succeeded only by running placeholder or stub behavior, not real task output.";
  }

  const text = [
    input.step.id,
    input.step.title,
    input.step.instructions,
    input.step.suggestedImplementation ?? "",
    input.step.testGuidance ?? "",
    ...(input.step.successCriteria ?? []),
  ].join("\n").toLowerCase();

  if (isImplementationLikeStep(input.step)) {
    for (const relativePath of collectExplicitStepFileReferences(input.step, input.toolResults)) {
      const source = readWorkspaceTextIfExists(input.workspaceRoot, relativePath);
      if (!source) {
        return `the step references '${relativePath}', but that file does not exist yet.`;
      }
      if (isSourceLikePath(relativePath) && isLikelyPlaceholderSource(source)) {
        return `${relativePath} exists but still looks like a placeholder or trivial implementation.`;
      }
    }
  }

  if (/(?:build|compile|cmake|make|test|verify)/.test(text)) {
    const buildWindow = input.toolResults.slice(-40);
    const lastFailedBuildIndex = findLastIndexCompat(
      buildWindow,
      (result) => !result.ok && result.name === "run_shell_command" && isBuildCommand(getToolResultCommand(result)),
    );
    const lastSuccessfulBuildIndex = findLastIndexCompat(
      buildWindow,
      (result) => result.ok && result.name === "run_shell_command" && isBuildCommand(getToolResultCommand(result)),
    );
    const hasRecentFailedBuild = lastFailedBuildIndex >= 0;
    const hasLaterSuccessfulBuild = lastSuccessfulBuildIndex > lastFailedBuildIndex;
    if (hasRecentFailedBuild && !hasLaterSuccessfulBuild) {
      return "recent build/compile command failed and there is no later successful build/compile check.";
    }
  }

  if (isVerificationDrivenPlanStep(input.step)) {
    const validationWindow = input.toolResults.slice(-12);
    const latestWeakValidation = findLastIndexCompat(validationWindow, (result) => isWeakPrintOnlyValidationResult(result, input.step));
    const latestStrictValidation = findLastIndexCompat(
      validationWindow,
      (result) => result.ok && result.name === "run_shell_command" && isSuccessfulStrictVerificationResult(result, getToolResultCommand(result)),
    );
    if (latestWeakValidation >= 0 && latestStrictValidation <= latestWeakValidation) {
      return "latest validation command only printed observed values without an assertion or explicit failing exit path. Rerun validation as a strict command that encodes the expected condition and exits nonzero on mismatch.";
    }
  }

  return undefined;
}

function isWeakPrintOnlyValidationResult(result: ToolResult, step: ExecutionPlanStep): boolean {
  if (!result.ok || result.name !== "run_shell_command") return false;
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
    if (result.ok && ["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(result.name) && typeof args.path === "string") {
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
        .filter((result) => result.name === "run_shell_command" && (isBuildCommand(getToolResultCommand(result)) || isCompileOrBuildError(result.error?.message ?? "")))
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
  if (!result.ok || result.name !== "run_shell_command") return false;
  if (isSemanticFailedCheckResult(result)) return false;
  const command = getToolResultCommand(result);
  if (isSuccessfulStrictVerificationResult(result, command)) return true;
  const semantic = classifyShellCommandSemantics(command);
  if (semantic.kind === "producer" && isProducerOrVerificationCommand(command)) return true;
  if (blocker && isSemanticFailedCheckResult(blocker) && hasNontrivialSemanticCleanShellOutput(result)) return true;
  return Boolean(blocker && isSameRuntimeFamilyRecovery(blocker, result));
}

function hasNontrivialSemanticCleanShellOutput(result: ToolResult): boolean {
  if (!result.ok || result.name !== "run_shell_command") return false;
  if (isSemanticFailedCheckResult(result) || hasPlaceholderShellOutput(result)) return false;
  const text = getToolResultText(result);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 3 && lines.some((line) => /\d/.test(line))) return true;
  return text.replace(/\s+/g, " ").trim().length >= 160;
}

function isSameRuntimeFamilyRecovery(blocker: ToolResult, result: ToolResult): boolean {
  if (blocker.name !== "run_shell_command" || result.name !== "run_shell_command") return false;
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
    if (result.name !== "run_shell_command") return false;
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
        "If any blockers exist and no later producer/build/test/check succeeded, do not emit complete_task. Repair the blocker and prove it with a successful command first.",
    }),
  ].join("\n");
}

function isValidationOfMissingArtifacts(command: string, missingArtifacts: string[]): boolean {
  if (!command.trim()) return false;
  if (isSandboxServiceDiagnosticPath(command)) return false;
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

function isSandboxServiceDiagnosticPath(value: string): boolean {
  return value.replace(/\\/g, "/").includes("/.reaper/sandbox-services/");
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

function isRuntimeOrVerificationFailure(result: ToolResult): boolean {
  if (isSemanticFailedCheckResult(result)) return true;
  const message = result.error?.message ?? "";
  const command = getToolResultCommand(result);
  return (
    result.name === "run_shell_command" &&
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

function isExternalRuntimeLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    /(^|\/)(?:site-packages|dist-packages|\.venv|venv|env|vendor\/bundle|gems|Pods|DerivedData)(\/|$)/i.test(normalized) ||
    /^\/(?:usr|opt|nix|snap|var\/lib|Library|System)\//i.test(normalized) ||
    /^[A-Za-z]:\/(?:Program Files|Windows|Users\/[^/]+\/AppData)\//i.test(normalized)
  );
}

function isToolchainOrDependencyDiagnosticPath(filePath: string): boolean {
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

function shouldBlockRuntimeBeforeSuccessfulBuild(command: string, previousResults: ToolResult[]): boolean {
  if (!isBuildArtifactRuntimeCommand(command)) return false;
  const recent = previousResults
    .filter((result) => result.name === "run_shell_command")
    .slice(-12);
  const hasRecentMissingArtifact = recent.some((result) => !result.ok && /No such file or directory|not found|cannot access/i.test(result.error?.message ?? ""));
  if (!hasRecentMissingArtifact) return false;
  const lastSuccessfulBuildIndex = findLastIndexCompat(recent, (result) => result.ok && isBuildCommand(getToolResultCommand(result)));
  const lastBuildFailureIndex = findLastIndexCompat(recent, (result) => !result.ok && isBuildCommand(getToolResultCommand(result)));
  return lastBuildFailureIndex > lastSuccessfulBuildIndex;
}

function findLastIndexCompat<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function guardVerifierOwnedPathMutations(toolCalls: ToolCall[]): { allowed: ToolCall[]; blockedResults: ToolResult[] } {
  const allowed: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  for (const call of toolCalls) {
    if (isVerifierOwnedPathMutation(call)) {
      blockedResults.push({
        toolCallId: call.id,
        name: call.name,
        ok: false,
        durationMs: 0,
        args: call.args,
        error: {
          code: "verifier_owned_path_write_blocked",
          message:
            "Reaper blocked a mutation to external verifier-owned absolute /tests paths. Treat harness files as read-only and satisfy their checks by changing workspace source/artifacts instead.",
        },
      });
      continue;
    }
    allowed.push(call);
  }
  return { allowed, blockedResults };
}

function isVerifierOwnedPathMutation(call: ToolCall): boolean {
  if (call.name === "run_shell_command") return shouldBlockVerifierOwnedShellMutation(getShellCommandArg(call));
  if (!["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(call.name)) return false;
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
  const targetPath = typeof args.path === "string" ? args.path.replace(/\\/g, "/") : "";
  return /^\/(?:tests?|__tests__)(?:\/|$)/.test(targetPath);
}

function getToolResultSummary(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof args.summary === "string" ? args.summary : "";
}

function isBuildArtifactRuntimeCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (isBuildCommand(normalized)) return false;
  if (/(?:^|[;&|]\s*|\bdo\s+)(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/.test(normalized)) return true;
  return /\b(?:xargs|parallel|find)\b.*(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/.test(normalized);
}

function countRecentBroadTestTimeoutFailures(results: ToolResult[]): number {
  let count = 0;
  for (const result of results.slice(-16)) {
    if (result.ok || result.name !== "run_shell_command") continue;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    const message = result.error?.message ?? "";
    if (isBroadTestCommand(cmd) && isTestTimeoutOrOpenHandleFailure(message)) {
      count += 1;
    }
  }
  return count;
}

function isBroadTestCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!isTestCommand(normalized)) return false;
  if (/\b(?:--runInBand|--detectOpenHandles|--testNamePattern|-t\s+|--findRelatedTests|--runTestsByPath)\b/i.test(normalized)) return false;
  if (/\b(?:__tests__|tests?\/|\.test\.|\.spec\.)/i.test(normalized)) return false;
  return true;
}

function isTestTimeoutOrOpenHandleFailure(message: string): boolean {
  return /timed out after|Exceeded timeout|open handle|Jest did not exit|TCPSERVERWRAP|beforeAll|beforeEach|afterAll|afterEach|server selection timed out|MongoServerSelectionError|buffering timed out/i.test(
    message,
  );
}

function countFailedActionSignatures(results: ToolResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (result.ok) continue;
    const signature = makeToolResultActionSignature(result);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function countSuccessfulDependencySetupSignatures(results: ToolResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (!result.ok) continue;
    const signature = makeDependencySetupToolResultSignature(result);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function hasSuccessfulMutationAfterLatestFailure(signature: string, results: ToolResult[]): boolean {
  const latestFailureIndex = findLatestFailedActionIndex(signature, results);
  if (latestFailureIndex < 0) return false;
  return results.slice(latestFailureIndex + 1).some((result) => isSuccessfulMutationResult(result));
}

function findLatestFailedActionIndex(signature: string, results: ToolResult[]): number {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result) continue;
    if (result.ok) continue;
    if (makeToolResultActionSignature(result) === signature) return index;
  }
  return -1;
}

function shouldBlockSameBatchDependentCheck(call: Extract<ToolCall, { name: "run_shell_command" }>, toolCalls: ToolCall[], previousResults: ToolResult[]): boolean {
  const command = getShellCommandArg(call);
  if (!command.trim()) return false;
  if (!hasStateChangingToolInCurrentBatch(toolCalls, call.id)) return false;
  if (isMutatingShellCommand(command)) return false;
  if (isCheckLikeShellCommand(command) || isReadOnlyRuntimeInspectionCommand(command)) return true;
  return Boolean(hasPriorFailedShellCommand(command, previousResults));
}

function shouldBlockSameBatchReadOnlyInspection(call: ToolCall, toolCalls: ToolCall[]): boolean {
  if (call.name === "run_shell_command") {
    const command = getShellCommandArg(call);
    return !isMutatingShellCommand(command) && isReadOnlyRuntimeInspectionCommand(command) && hasStateChangingToolInCurrentBatch(toolCalls, call.id);
  }
  if (!["read_file", "view_file", "skim_file", "list_directory", "grep_search"].includes(call.name)) return false;
  return hasStateChangingToolInCurrentBatch(toolCalls, call.id);
}

function hasStateChangingToolInCurrentBatch(toolCalls: ToolCall[], excludingId: string): boolean {
  return toolCalls.some((item) => {
    if (item.id === excludingId) return false;
    if (isMutatingToolCall(item)) return true;
    return item.name === "run_shell_command" && isMutatingShellCommand(getShellCommandArg(item));
  });
}

function getSameStateShellRetryBlocker(call: ToolCall, results: ToolResult[]): { code: string; message: string } | undefined {
  if (call.name !== "run_shell_command") return undefined;
  const command = getShellCommandArg(call);
  const actionSignature = makeToolCallActionSignature(call);
  if (actionSignature) {
    const latestFailureIndex = findLatestFailedActionIndex(actionSignature, results);
    if (latestFailureIndex >= 0 && !hasSuccessfulStateChangeAfter(latestFailureIndex, results)) {
      return {
        code: "same_state_failed_action_retry_blocked",
        message:
          `Reaper blocked '${actionSignature}' because the same command already failed and no successful state-changing action has happened since. ` +
          "Use the prior stdout/stderr as current state. Repair or change the environment/files first, or choose a materially different diagnostic.",
      };
    }
  }

  const setupSignature = makeDependencySetupToolCallSignature(call);
  if (!setupSignature) return undefined;
  const latestSetupIndex = findLatestSuccessfulDependencySetupIndex(setupSignature, results);
  if (latestSetupIndex < 0) return undefined;
  const afterSetup = results.slice(latestSetupIndex + 1);
  const setupDidNotChangeObservedFailure =
    afterSetup.some((result) => !result.ok && result.name === "run_shell_command") &&
    !afterSetup.some(isSuccessfulStateChangingResult);
  if (!setupDidNotChangeObservedFailure) return undefined;
  return {
    code: "same_state_setup_retry_blocked",
    message:
      `Reaper blocked setup command '${setupSignature}' because it already succeeded once, then a later command still failed without any successful state-changing repair after that. ` +
      "Treat the setup result as observed state. Do not reinstall/bootstrap the same toolchain; inspect the exact failure and make a different repair before retrying setup.",
  };
}

function hasPriorFailedShellCommand(command: string, results: ToolResult[]): boolean {
  const signature = `run_shell_command:${JSON.stringify({ cmd: normalizeCommandForSignature(command) })}`;
  return findLatestFailedActionIndex(signature, results) >= 0;
}

function findLatestSuccessfulDependencySetupIndex(signature: string, results: ToolResult[]): number {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result?.ok) continue;
    if (makeDependencySetupToolResultSignature(result) === signature) return index;
  }
  return -1;
}

function hasSuccessfulStateChangeAfter(index: number, results: ToolResult[]): boolean {
  return results.slice(index + 1).some(isSuccessfulStateChangingResult);
}

function isSuccessfulStateChangingResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (isSuccessfulMutationResult(result)) return true;
  if (result.name !== "run_shell_command") return false;
  const command = getToolResultCommand(result);
  return (
    isMutatingShellCommand(command) ||
    isBuildCommand(command) ||
    isDependencySetupCommand(command) ||
    isRuntimeEnvironmentSetupCommand(command) ||
    Boolean(makeDependencySetupToolResultSignature(result))
  );
}

function isSuccessfulMutationResult(result: ToolResult): boolean {
  if (!result.ok) return false;
  if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name)) return true;
  return isMutatingSandboxServiceControlResult(result);
}

function isMutatingSandboxServiceControlResult(result: ToolResult): boolean {
  if (result.name !== "sandbox_service_control") return false;
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const action = typeof args.action === "string" ? args.action : "";
  return ["exec", "write_file", "copy_to_service", "restore_from_image", "restart", "start", "stop"].includes(action);
}

function countTrailingLowInformationActionSignatures(results: ToolResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  let lastSignature: string | undefined;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result?.ok) break;
    const signature = makeLowInformationToolResultSignature(result);
    if (!signature) break;
    if (lastSignature && signature !== lastSignature) break;
    lastSignature = signature;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function countRecentLowInformationActionSignatures(results: ToolResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results.slice(-24)) {
    if (!result.ok) continue;
    const signature = makeLowInformationToolResultSignature(result);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function makeLowInformationToolCallSignature(call: ToolCall): string | undefined {
  if (call.name === "read_file" || call.name === "view_file" || call.name === "list_directory") {
    const args = call.args as { path?: unknown };
    return typeof args.path === "string" ? `${call.name}:${JSON.stringify({ path: args.path })}` : undefined;
  }
  if (call.name === "grep_search") {
    const args = call.args as { pattern?: unknown; path?: unknown; include?: unknown };
    return typeof args.pattern === "string"
      ? `${call.name}:${JSON.stringify({ pattern: args.pattern, path: args.path, include: args.include })}`
      : undefined;
  }
  if (call.name === "run_shell_command") {
    const command = getShellCommandArg(call);
    return isLowInformationShellCommand(command) && !isMutatingShellCommand(command)
      ? `${call.name}:${JSON.stringify({ cmd: normalizeCommandForSignature(command) })}`
      : undefined;
  }
  return undefined;
}

function makeLowInformationToolResultSignature(result: ToolResult): string | undefined {
  if (result.name === "read_file" || result.name === "view_file" || result.name === "list_directory") {
    const args = result.args && typeof result.args === "object" ? (result.args as { path?: unknown }) : {};
    return typeof args.path === "string" ? `${result.name}:${JSON.stringify({ path: args.path })}` : undefined;
  }
  if (result.name === "grep_search") {
    const args = result.args && typeof result.args === "object" ? (result.args as { pattern?: unknown; path?: unknown; include?: unknown }) : {};
    return typeof args.pattern === "string"
      ? `${result.name}:${JSON.stringify({ pattern: args.pattern, path: args.path, include: args.include })}`
      : undefined;
  }
  if (result.name === "run_shell_command") {
    const command = getToolResultCommand(result);
    return isLowInformationShellCommand(command) ? `${result.name}:${JSON.stringify({ cmd: normalizeCommandForSignature(command) })}` : undefined;
  }
  return undefined;
}

function makeToolCallActionSignature(call: ToolCall): string | undefined {
  if (call.name === "run_shell_command") {
    const cmd = typeof call.args.cmd === "string" ? normalizeCommandForSignature(call.args.cmd) : "";
    return cmd ? `${call.name}:${JSON.stringify({ cmd })}` : undefined;
  }
  if (call.name === "sandbox_service_control") {
    const args = call.args as Record<string, unknown>;
    return `${call.name}:${JSON.stringify({
      action: args.action,
      service: args.service,
      command: typeof args.command === "string" ? normalizeCommandForSignature(args.command) : undefined,
      targetPath: args.targetPath,
      sourcePath: args.sourcePath,
    })}`;
  }
  if (call.name === "replace_in_file") {
    const args = call.args as Record<string, unknown>;
    if (typeof args.oldString !== "string") return undefined;
    return `${call.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "oldString"].includes(key))))}`;
  }
  if (["edit_file", "replace_symbol"].includes(call.name)) {
    const args = call.args as Record<string, unknown>;
    return `${call.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "symbolName"].includes(key))))}`;
  }
  return undefined;
}

function makeDependencySetupToolCallSignature(call: ToolCall): string | undefined {
  if (call.name !== "run_shell_command") return undefined;
  const cmd = typeof call.args.cmd === "string" ? normalizeCommandForSignature(call.args.cmd) : "";
  return isDependencySetupCommand(cmd) ? `${call.name}:${JSON.stringify({ cmd: canonicalizeDependencySetupCommand(cmd) })}` : undefined;
}

function makeDependencySetupToolResultSignature(result: ToolResult): string | undefined {
  if (result.name !== "run_shell_command") return undefined;
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  const cmd = typeof args.cmd === "string" ? normalizeCommandForSignature(args.cmd) : "";
  return isDependencySetupCommand(cmd) ? `${result.name}:${JSON.stringify({ cmd: canonicalizeDependencySetupCommand(cmd) })}` : undefined;
}

function isDependencySetupCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (
    /\bpython(?:3)?\s+-m\s+ensurepip\b/i.test(normalized) ||
    /\bpython(?:3)?\s+-m\s+pip\s+install\b/i.test(normalized) ||
    /\bpip(?:3)?\s+install\b/i.test(normalized) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/i.test(normalized) ||
    /\b(?:cargo\s+install|go\s+install|gem\s+install|bundle\s+install)\b/i.test(normalized)
  );
}

function isRuntimeEnvironmentSetupCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    isInstallOrUpgradeCommand(normalized.toLowerCase()) ||
    /\b(?:apt(?:-get)?|dnf|yum|apk|pacman|brew)\s+(?:update|install|add|upgrade)\b/i.test(normalized) ||
    /\b(?:python3?|pipenv|poetry|uv|conda|mamba|npm|pnpm|yarn|bun|cargo|go|bundle|gem)\b[\s\S]*\b(?:install|sync|restore|build|compile|setup|develop)\b/i.test(
      normalized,
    )
  );
}

function canonicalizeDependencySetupCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (/\bpython(?:3)?\s+-m\s+ensurepip\b/i.test(normalized)) return "python -m ensurepip";
  if (/\bpython(?:3)?\s+-m\s+pip\s+install\b/i.test(normalized)) return normalized.replace(/\bpython3?\b/i, "python");
  if (/\bpip(?:3)?\s+install\b/i.test(normalized)) return normalized.replace(/\bpip3\b/i, "pip");
  return normalized;
}

function makeToolResultActionSignature(result: ToolResult): string | undefined {
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  if (result.name === "run_shell_command") {
    const cmd = typeof args.cmd === "string" ? normalizeCommandForSignature(args.cmd) : "";
    return cmd ? `${result.name}:${JSON.stringify({ cmd })}` : undefined;
  }
  if (result.name === "sandbox_service_control") {
    return `${result.name}:${JSON.stringify({
      action: args.action,
      service: args.service,
      command: typeof args.command === "string" ? normalizeCommandForSignature(args.command) : undefined,
      targetPath: args.targetPath,
      sourcePath: args.sourcePath,
    })}`;
  }
  if (result.name === "replace_in_file") {
    if (typeof args.oldString !== "string") return undefined;
    return `${result.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "oldString"].includes(key))))}`;
  }
  if (["edit_file", "replace_symbol"].includes(result.name)) {
    return `${result.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "symbolName"].includes(key))))}`;
  }
  return undefined;
}

function getCompletionSummary(toolCalls: ToolCall[]): string | undefined {
  const completion = toolCalls.find(
    (call): call is Extract<ToolCall, { name: "complete_task" }> => call.name === "complete_task",
  );
  return completion?.args.summary;
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
    return "complex_orchestrator";
  }
  if (text.includes("complex task") || matchedSignals >= 2 || prompt.length > 500 || (matchedSignals >= 1 && existingFiles > 80)) {
    return "complex_orchestrator";
  }
  return "simple_executor";
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

function createStuckDetectionState(): StuckDetectionState {
  return {
    toolFailureSignatures: [],
    lowInformationActionSignatures: [],
    verificationFailureSignatures: [],
    processedToolCallIds: [],
    actionObservationSignatures: [],
    noActionTurns: 0,
    tripped: false,
    repeatedCount: 0,
  };
}

async function updateStuckDetectionAfterTools(input: {
  workspaceRoot: string;
  runId: string;
  previous: StuckDetectionState;
  split?: SplitToolCalls;
  toolResults: ToolResult[];
  expanded?: { enabled: boolean; alternatingPatternLength: number; noActionTurnLimit: number };
  ignoreNoAction?: boolean;
}): Promise<StuckDetectionState> {
    if (input.previous.tripped) return input.previous;
    const noActionBatch =
      !input.ignoreNoAction &&
      Boolean(input.split) &&
      (input.split?.executableToolCalls.length ?? 0) === 0 &&
      !input.split?.completionSignal &&
      !input.split?.advancementSignal;
    if (input.expanded?.enabled !== false && noActionBatch) {
      const noActionTurns = input.previous.noActionTurns + 1;
      const tripped = noActionTurns >= (input.expanded?.noActionTurnLimit ?? 3);
      const next = {
        ...input.previous,
        noActionTurns,
        repeatedCount: noActionTurns,
        tripped,
        ...(tripped ? { reason: `Tool-free monologue/no-action loop detected across ${noActionTurns} consecutive turn(s).` } : {}),
      };
      if (tripped) await persistStuckDetection(input.workspaceRoot, input.runId, next);
      return next;
    }
	  const currentIds = new Set(input.split?.executableToolCalls.map((call) => call.id) ?? []);
	  const alreadyProcessed = new Set(input.previous.processedToolCallIds);
	  const indexedCurrentResults = input.toolResults
	    .map((result, index) => ({ result, key: `${index}:${result.toolCallId}` }))
	    .filter(({ result, key }) => currentIds.has(result.toolCallId) && !alreadyProcessed.has(key));
	  const currentResults = indexedCurrentResults.map(({ result }) => result);
	  if (currentResults.length === 0) return input.previous;
	  const processedToolCallIds = [...input.previous.processedToolCallIds, ...indexedCurrentResults.map(({ key }) => key)].slice(-200);
    const actionObservationSignatures = [
      ...input.previous.actionObservationSignatures,
      ...currentResults.map((result) => `${makeProgressToolResultActionSignature(result)}=>${makeToolResultObservationSignature(result)}`),
    ].slice(-20);
    if (input.expanded?.enabled !== false) {
      const alternating = detectAlternatingNoProgressPattern(input.toolResults, input.expanded?.alternatingPatternLength ?? 6);
      if (alternating.tripped) {
        const next: StuckDetectionState = {
          ...input.previous,
          processedToolCallIds,
          actionObservationSignatures,
          noActionTurns: 0,
          repeatedCount: input.expanded?.alternatingPatternLength ?? 6,
          tripped: true,
          reason: alternating.reason ?? "Alternating no-progress action/observation loop detected.",
        };
        await persistStuckDetection(input.workspaceRoot, input.runId, next);
        return next;
      }
    }
  const failed = currentResults.filter((result) => !result.ok);
  const lowInformationBlocked = failed.find(isLowInformationBlockedResult);
  if (lowInformationBlocked) {
    const next: StuckDetectionState = {
      ...input.previous,
      processedToolCallIds,
      actionObservationSignatures,
      noActionTurns: 0,
      repeatedCount: Math.max(input.previous.repeatedCount, 1),
      tripped: true,
      reason: lowInformationBlocked.error?.message ?? "Repeated low-information tool batch was blocked.",
    };
    await persistStuckDetection(input.workspaceRoot, input.runId, next);
    return next;
  }
  const failedForStuckDetection = failed.filter((result) => !isRecoverableToolFailure(result));
  const lowInformationActions = currentResults.filter((result) => result.ok && isLowInformationToolResult(result));
  if (failedForStuckDetection.length === 0) {
    const nextLowInformationSignatures = [
      ...input.previous.lowInformationActionSignatures,
      ...lowInformationActions.map(makeLowInformationActionSignature),
    ].slice(-12);
    const last = nextLowInformationSignatures.at(-1);
    const repeatedCount = last ? countTrailing(nextLowInformationSignatures, last) : 0;
    const tripped = repeatedCount >= 8;
    const next: StuckDetectionState = {
      ...input.previous,
      processedToolCallIds,
      actionObservationSignatures,
      noActionTurns: 0,
      lowInformationActionSignatures: nextLowInformationSignatures,
      repeatedCount,
      tripped,
      ...(tripped ? { reason: `Repeated low-information tool pattern: ${last}` } : {}),
    };
    if (tripped) {
      await persistStuckDetection(input.workspaceRoot, input.runId, next);
    }
    return tripped || lowInformationActions.length > 0 ? next : { ...input.previous, processedToolCallIds, repeatedCount: 0 };
  }

  const nextSignatures = [...input.previous.toolFailureSignatures, ...failedForStuckDetection.map(makeToolFailureSignature)].slice(-8);
  const last = nextSignatures.at(-1);
  const repeatedCount = last ? countTrailing(nextSignatures, last) : 0;
  const tripped = repeatedCount >= 3;
  const next: StuckDetectionState = {
    ...input.previous,
    processedToolCallIds,
    actionObservationSignatures,
    noActionTurns: 0,
    toolFailureSignatures: nextSignatures,
    repeatedCount,
    tripped,
    ...(tripped ? { reason: `Repeated failed tool pattern: ${last}` } : {}),
  };
  if (tripped) {
    await persistStuckDetection(input.workspaceRoot, input.runId, next);
  }
  return next;
}

function isRecoverableToolFailure(result: ToolResult): boolean {
  return isStaleWriteRequiresReadResult(result);
}

function isLowInformationBlockedResult(result: ToolResult): boolean {
  return (
	    !result.ok &&
	    (result.error?.code === "repeated_read_only_batch_blocked" ||
	      result.error?.code === "repeated_low_information_action_blocked" ||
	      result.error?.code === "no_progress_loop_blocked" ||
	      result.error?.code === "same_state_failed_action_retry_blocked" ||
	      result.error?.code === "repeated_failed_action_blocked")
	  );
}

export function isLowInformationToolResult(result: ToolResult): boolean {
  if (result.name === "run_shell_command") return isLowInformationShellCommand(getToolResultCommand(result));
  if (result.name !== "read_file" && result.name !== "view_file" && result.name !== "list_directory" && result.name !== "grep_search") return false;
  const args = result.args as { path?: unknown; pattern?: unknown };
  return result.name === "grep_search" ? typeof args.pattern === "string" : typeof args.path === "string";
}

function makeLowInformationActionSignature(result: ToolResult): string {
  if (result.name === "run_shell_command") return `${result.name}:${JSON.stringify({ cmd: normalizeCommandForSignature(getToolResultCommand(result)) })}`;
  const args = result.args as { path?: unknown; pattern?: unknown; include?: unknown };
  return result.name === "grep_search"
    ? `${result.name}:${JSON.stringify({ pattern: args.pattern, path: args.path, include: args.include })}`
    : `${result.name}:${JSON.stringify({ path: args.path })}`;
}

async function updateStuckDetectionAfterVerification(input: {
  workspaceRoot: string;
  runId: string;
  previous: StuckDetectionState;
  verification: NonNullable<RuntimeEngineResult["verification"]>;
}): Promise<StuckDetectionState> {
  if (input.previous.tripped || input.verification.ok) return input.previous;
  const latestFeedback = input.verification.feedback?.at(-1);
  if (!latestFeedback) return input.previous;
  const signature = `verification:${classifyVerificationFailure(latestFeedback)}:${stableHash(latestFeedback.slice(-4000))}`;
  const nextSignatures = [...input.previous.verificationFailureSignatures, signature].slice(-6);
  const repeatedCount = countTrailing(nextSignatures, signature);
  const tripped = repeatedCount >= 2;
  const next: StuckDetectionState = {
    ...input.previous,
    verificationFailureSignatures: nextSignatures,
    repeatedCount,
    tripped,
    ...(tripped ? { reason: `Repeated verification failure pattern: ${signature}` } : {}),
  };
  if (tripped) {
    await persistStuckDetection(input.workspaceRoot, input.runId, next);
  }
  return next;
}

function makeToolFailureSignature(result: ToolResult): string {
  const args = result.args && typeof result.args === "object" ? result.args as Record<string, unknown> : {};
  const relevantArgs =
    result.name === "run_shell_command"
      ? { cmd: typeof args.cmd === "string" ? normalizeCommandForSignature(args.cmd) : "" }
      : Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "pattern", "symbolName", "taskId"].includes(key)));
  const error = result.name === "run_shell_command" ? "" : (result.error?.message ?? "");
  return `${result.name}:${JSON.stringify(relevantArgs)}:${stableHash(error.slice(0, 1000))}`;
}

function normalizeCommandForSignature(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function countTrailing(values: string[], target: string): number {
  let count = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== target) break;
    count += 1;
  }
  return count;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function persistStuckDetection(workspaceRoot: string, runId: string, state: StuckDetectionState): Promise<void> {
  const runDir = path.join(getReaperScratchpadPaths(workspaceRoot).runs, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "stuck.json"), JSON.stringify({ runId, ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

export function normalizePlannerStepTypeLabel(type: PlannerStepType, text: string): PlannerStepType {
  return normalizePlanStepType(type, text);
}

function reconcileReplannedProgress(input: {
  previousPlan: ExecutionPlanStep[];
  nextPlan: ExecutionPlanStep[];
  completedStepIds: string[];
  previousCurrentStepIndex: number;
}): { currentStepIndex: number; completedStepIds: string[] } {
  if (input.previousPlan.length === 0 || input.completedStepIds.length === 0 || input.nextPlan.length === 0) {
    return { currentStepIndex: 0, completedStepIds: [] };
  }

  const completedPrevious = input.previousPlan.filter((step) => input.completedStepIds.includes(step.id));
  const matchedNextIds = new Set<string>();

  for (const previous of completedPrevious) {
    const match = findEquivalentPlanStep(previous, input.nextPlan, matchedNextIds);
    if (match) {
      matchedNextIds.add(match.id);
    }
  }

  const completedStepIds: string[] = [];
  for (const step of input.nextPlan) {
    if (!matchedNextIds.has(step.id)) break;
    completedStepIds.push(step.id);
  }
  const currentStepIndex = completedStepIds.length;
  return {
    currentStepIndex,
    completedStepIds,
  };
}

function findEquivalentPlanStep(
  previous: ExecutionPlanStep,
  nextPlan: ExecutionPlanStep[],
  alreadyMatched: Set<string>,
): ExecutionPlanStep | undefined {
  const previousId = normalizePlanStepText(previous.id);
  const previousTitle = normalizePlanStepText(previous.title);
  const previousInstruction = normalizePlanStepText(previous.instructions);
  return nextPlan.find((candidate) => {
    if (alreadyMatched.has(candidate.id)) return false;
    const candidateId = normalizePlanStepText(candidate.id);
    const candidateTitle = normalizePlanStepText(candidate.title);
    const candidateInstruction = normalizePlanStepText(candidate.instructions);
    if (previousId && candidateId && previousId === candidateId) return true;
    if (previousTitle && candidateTitle && previousTitle === candidateTitle) return true;
    if (previousTitle && candidateTitle && textSimilarity(previousTitle, candidateTitle) >= 0.72) return true;
    if (previousInstruction && candidateInstruction && textSimilarity(previousInstruction, candidateInstruction) >= 0.82) return true;
    return false;
  });
}

function hasSuccessfulLocalVerification(results: ToolResult[]): boolean {
  return results.some((result) => {
    if (!result.ok || result.name !== "run_shell_command") return false;
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
    if (!result.ok || result.name !== "run_shell_command") return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    return isSuccessfulVerificationResult(result, cmd, output);
  });
}

function hasRecentSuccessfulAcceptanceEvidence(results: ToolResult[]): boolean {
  return hasSuccessfulAcceptanceEvidence(results.slice(-12));
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
  const parsed = Number(process.env.REAPER_MAIN_AGENT_TRANSPORT_RETRY_LIMIT ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

export function selectRecentStrictVerificationEvidence(results: ToolResult[]): { command: string } | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result || !result.ok || result.name !== "run_shell_command") continue;
    const command = getToolResultCommand(result);
    if (!isSuccessfulStrictVerificationResult(result, command)) continue;
    return { command };
  }
  return undefined;
}

function hasVerificationFailureClass(verification: RuntimeEngineResult["verification"] | undefined, failureClass: string): boolean {
  return verification?.failureClasses?.includes(failureClass) === true;
}

function hasExplicitVerificationRequest(request: AgentRequestEnvelope): boolean {
  const verification = request.payload.verification;
  return Boolean(verification && typeof verification === "object" && typeof (verification as { command?: unknown }).command === "string");
}

function shouldRunVerificationForCompletion(
  request: AgentRequestEnvelope,
  completionSignal: Extract<ToolCall, { name: "complete_task" }> | undefined,
  config: ReaperConfig,
): boolean {
  return config.verification.requireGroundedCompletion || hasExplicitVerificationRequest(request) || Boolean(completionSignal?.args.verificationContract?.commands?.length);
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

function hasRepeatedSuccessfulVerification(results: ToolResult[]): boolean {
  const counts = new Map<string, number>();
  for (const result of results.slice(-20)) {
    if (!result.ok || result.name !== "run_shell_command") continue;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
    const cmd = typeof args.cmd === "string" ? normalizeVerificationCommand(args.cmd) : "";
    if (!cmd || output.exitCode !== 0 || !isVerificationLikeCommand(cmd) || isSemanticFailedCheckResult(result)) continue;
    counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
    if ((counts.get(cmd) ?? 0) >= 2) return true;
  }
  return false;
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
    if (!result.ok || !["write_file", "replace_in_file", "edit_file", "replace_symbol"].includes(result.name)) return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const target = typeof args.path === "string" ? args.path.replace(/\\/g, "/") : "";
    return /(?:^|\/)(?:CMakeLists\.txt|Makefile|GNUMakefile|meson\.build|BUILD(?:\.bazel)?|WORKSPACE|configure\.ac|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(
      target,
    );
  });
  if (!wroteBuildConfig) return false;
  return currentResults.some((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
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
    if (result.name !== "run_shell_command") return false;
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
  if (!isInspectionLikeStep || result.name !== "run_shell_command") return false;
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

function hasCurrentBatchStepCompletionEvidence(
  toolCalls: ToolCall[],
  results: ToolResult[],
  options: { allowWriteOnlyCompletion: boolean },
): boolean {
  if (toolCalls.length === 0) return false;
  const ids = new Set(toolCalls.map((call) => call.id));
  return results.some((result) => {
    if (!ids.has(result.toolCallId) || !result.ok) return false;
    if (["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "task_create", "task_update"].includes(result.name)) {
      return options.allowWriteOnlyCompletion;
    }
    if (result.name === "run_shell_command") {
      const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      const cmd = typeof args.cmd === "string" ? args.cmd : "";
      return output.exitCode === 0 && !isLowInformationShellCommand(cmd) && !hasPlaceholderShellOutput(result);
    }
    return false;
  });
}

function hasPlaceholderShellOutput(result: ToolResult): boolean {
  if (result.name !== "run_shell_command" || !result.ok) return false;
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      if (/^#?\s*todo\s+(?:0|none)\b/i.test(line) || /^#?\s*(?:0\s+)?todos?\b/i.test(line)) return false;
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

function getPendingStaleWriteReadRepair(toolResults: ToolResult[]): { path: string; failedToolCallId: string } | undefined {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || !isStaleWriteRequiresReadResult(result)) continue;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const targetPath = typeof args.path === "string" ? args.path : undefined;
    if (!targetPath) continue;
    const hasLaterRead = toolResults.slice(index + 1).some((later) => {
      const laterArgs = later.args && typeof later.args === "object" ? (later.args as Record<string, unknown>) : {};
      return later.ok && later.name === "read_file" && laterArgs.path === targetPath;
    });
    if (!hasLaterRead) return { path: targetPath, failedToolCallId: result.toolCallId };
  }
  return undefined;
}

function getPendingFailedExactEditReadRepair(toolResults: ToolResult[]): { path: string; failedToolCallId: string } | undefined {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || !isFailedExactEditResult(result)) continue;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const targetPath = typeof args.path === "string" ? args.path : undefined;
    if (!targetPath) continue;
    const hasLaterRead = toolResults.slice(index + 1).some((later) => {
      const laterArgs = later.args && typeof later.args === "object" ? (later.args as Record<string, unknown>) : {};
      return later.ok && later.name === "read_file" && laterArgs.path === targetPath;
    });
    if (!hasLaterRead) return { path: targetPath, failedToolCallId: result.toolCallId };
  }
  return undefined;
}

function getPendingSafeEditRegionRepair(toolResults: ToolResult[]): { path: string; failedToolCallId: string } | undefined {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || !isSafeEditThresholdResult(result)) continue;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const targetPath = typeof args.path === "string" ? args.path : undefined;
    if (!targetPath) continue;
    const hasLaterBoundedRead = toolResults.slice(index + 1).some((later) => {
      const laterArgs = later.args && typeof later.args === "object" ? (later.args as Record<string, unknown>) : {};
      return (
        later.ok &&
        later.name === "read_file" &&
        laterArgs.path === targetPath &&
        typeof laterArgs.startLine === "number" &&
        typeof laterArgs.endLine === "number"
      );
    });
    if (!hasLaterBoundedRead) return { path: targetPath, failedToolCallId: result.toolCallId };
  }
  return undefined;
}

function isStaleWriteRequiresReadResult(result: ToolResult): boolean {
  const message = result.error?.message ?? "";
  return (
    !result.ok &&
    ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name) &&
    (result.error?.code === "stale_write_requires_read" || /(?:before reading it|changed since it was last read)/i.test(message))
  );
}

function isSafeEditThresholdResult(result: ToolResult): boolean {
  const message = result.error?.message ?? "";
  return (
    !result.ok &&
    ["replace_in_file", "edit_file", "replace_symbol"].includes(result.name) &&
    /safe-edit threshold|exceeds safe-edit/i.test(message)
  );
}

function isFailedExactEditResult(result: ToolResult): boolean {
  const message = result.error?.message ?? "";
  return (
    !result.ok &&
    ["replace_in_file", "edit_file", "replace_symbol"].includes(result.name) &&
    /(?:string not found|no match|not found in file|could not find|multiple matches)/i.test(message)
  );
}

function buildSimpleExecutorPrompt(input: {
  prompt: string;
  contentPrep: ContentPrepResult;
  repoInspection?: RepoInspection;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  blockingFacts?: RuntimeBlockingFacts;
  runId: string;
}): string {
  const recentResults = renderRecentToolResultsForPromptCompact(input.toolResults, input.feedback, 10);
  const fileTree = input.contentPrep.preparedContext.fileTree.slice(0, 160).join("\n");
  const context = input.contentPrep.preparedContext.chunks
    .slice(0, 6)
    .map((chunk) => chunk.content.slice(0, 4000))
    .join("\n\n---\n\n");
  const environment = renderFingerprintForPrompt(input.contentPrep.environmentFingerprint);

  return [
    "# Reaper Simple Task Executor",
    "You are the main Reaper agent executing a simple task directly. Do not invoke orchestration or subagents.",
    "Return ONLY JSON with shape {\"assistant_message\": string, \"tool_calls\": ToolCall[]}.",
    renderToolCallContract(input.runId),
    "For intermediate steps, assistant_message must be an empty string. The only task summary belongs in complete_task.args.summary at the end.",
    "Use one small batch of concrete tool calls.",
    "When the whole requested task is complete, emit a complete_task tool call with a concise model-written summary. Reaper will exit on that signal.",
    "If you return no tool_calls in simple-executor mode, Reaper will ask for more concrete action unless the whole task is complete.",
    "Do not emit complete_task until your testing step has run a real build/test/lint/runtime smoke check or testing is explicitly unavailable with evidence. Placeholder commands such as echo success, true, or exit 0 are not testing.",
    "",
	    renderOptimizationFrame({
	      prompt: input.prompt,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	      mode: "simple",
	    }),
	    "",
	    renderEpicStateForPrompt({
	      runId: input.runId,
	      prompt: input.prompt,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	    }),
	    "",
	    "# Tool Rules",
    "Use specific tools for file work: read_file/list_directory/grep_search/write_file/replace_in_file/edit_file/replace_symbol/delete_file.",
    "Use run_shell_command only for installs, tests, build/runtime checks, or operations the specific tools cannot express.",
    "For dependency discovery, run package-specific checks instead of dumping directories: npm ls <package>, npm view <package> version, node -e \"require.resolve('<package>')\", python -m pip show <package>, cargo tree -p <package>, go list -m <module>, or equivalent for the active ecosystem.",
    "For inspection-only commands, do not make optional utilities such as file, tree, realpath, readlink, du, or stat mandatory. If one is missing but you already got useful stdout from ls/find/read tools, advance the inspection step with that evidence or use a simpler built-in command.",
    "Use the package manager for the active ecosystem only. Do not install a C/C++ header or source library with npm/pnpm/yarn; do not install JavaScript packages with pip/cargo/go. For header-only/source-only dependencies, prefer existing vendored files, system packages, documented direct source/header downloads, or a small local implementation when that satisfies the task.",
    "Do not use broad recursive listings for dependency discovery. If structure is needed, use list_directory or a pruned command that excludes dependency/build/cache directories.",
    "If a build cache points at a different source root/configuration, remove only the task-local build/cache directory and reconfigure from the intended source root before retrying. This is allowed cleanup, not destructive source deletion.",
    "Long-running servers must be started as managed background processes. After health/runtime checks prove they work, stop them with signal_process when no longer needed.",
    "Before mutating an existing file, read it first. New files may be created with write_file.",
    "If a write_file result reports stale_write_requires_read or says the file must be read before editing, the only valid next call for that path is read_file. After that read succeeds, use replace_in_file/edit_file for targeted edits or write_file only for an intentional full overwrite.",
    "For quick runtime/import/compile checks, prefer non-destructive one-off commands from the workspace root. If you create a temporary check file, resolve imports/paths relative to that file and runtime, not by assumption.",
    "When any check fails, read the exact failing file/config/log and fix the cited artifact before rerunning the same command. Repeating an unchanged failing command is not progress.",
    "If build/test/runtime is currently failing, enter repair-only mode: make the smallest diagnostic fix, then rerun the same or narrower check before expanding features.",
    "Create or update the task-local test/check script as part of the model-managed testing step when useful.",
    "For complex app tasks, add or run a behavioral smoke/test check for the requested workflow. Do not keep rerunning only the build as final proof.",
    "For targeted npm tests, inspect package.json and run the actual test runner directly or use 'npm test -- <path>' only when the script forwards arguments. Do not use 'npm test <path>' blindly.",
    "Test imports must not start long-running servers as side effects. Export app/module construction separately from process startup and guard listen/start code behind the language's main-entry check.",
    "Do not assume external services such as databases or caches are running. Check availability first; if unavailable and Docker is unavailable, use a test-safe in-process, file-backed, mocked, or static verification path.",
    "Never cd to or install into the host repository root. Commands start in the task workspace; use relative paths or $WORKSPACE only.",
    "If the environment says Docker is unavailable, do not run docker/docker-compose. Create or inspect Docker files and validate them statically instead.",
    "",
    "# Task",
    input.prompt,
    "",
    "# Workspace",
    fileTree || "(empty)",
    "",
    input.repoInspection ? renderRepoInspectionForCockpit(input.repoInspection) : "Repository inspection: unavailable.",
    "",
    `# Environment\n${environment}`,
    "",
    `# Relevant Context\n${context || "(no indexed context)"}`,
    "",
    `# Recent Tool Results\n${JSON.stringify(recentResults)}`,
    "",
    renderDiagnosticTargeting(input.toolResults),
    "",
    renderRuntimeBlockingFacts(input.blockingFacts),
    "",
    renderArtifactObligationLedger(input.prompt, input.toolResults),
    "",
    renderContractCoverageMatrix(input.prompt, input.toolResults),
    "",
    input.feedback.length ? `# Verification Feedback\n${capFeedbackForContext(input.feedback).join("\n\n---\n\n")}` : "# Verification Feedback\nnone",
    "",
    input.negativeConstraints.length
      ? `# Do Not Repeat\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "# Do Not Repeat\nNo negative constraints recorded.",
  ].join("\n\n");
}

function renderRecentToolResultsForPrompt(results: ToolResult[], feedback: string[], count: number): Record<string, unknown>[] {
  const compact =
    hasRecentStructuredResponseFallbackFeedback(feedback) ||
    hasRecentIncompleteGeneratedArtifact(results) ||
    hasRecentLargeToolOutput(results) ||
    results.length > 12;
  const selected = selectContextEfficientRecentResults(results, count, compact);
  return selected.map((result) =>
    renderToolResultForModel(result, compact ? { compact: true, maxOutputChars: maxOutputCharsForCompactResult(result) } : { maxOutputChars: maxOutputCharsForCompactResult(result) }),
  );
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
 * content. write_file/run_shell_command/read_file results all collapse to a
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

  // run_shell_command: cmd + exit code + truncated output. The model needs the exit code to decide next action.
  if (result.name === "run_shell_command") {
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

export function renderOptimizationFrame(input: {
  prompt: string;
  currentStep?: ExecutionPlanStep | undefined;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  mode: "planner" | "executor" | "repair" | "patcher" | "simple";
}): string {
  const metrics = buildLiveOptimizationSnapshot(input.toolResults);
  const repeatedFailure = getRepeatedDiagnosticFailure(input.toolResults);
  const recentTouchedFiles = collectRecentlyTouchedFiles(input.toolResults).slice(0, 12);
  const latestFailureSummary = input.toolResults
    .slice()
    .reverse()
    .find((result) => !result.ok);
  const stepText = input.currentStep
    ? [
        input.currentStep.id,
        input.currentStep.title,
        input.currentStep.instructions,
        input.currentStep.suggestedImplementation ?? "",
        input.currentStep.testGuidance ?? "",
        ...(input.currentStep.successCriteria ?? []),
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  return [
    "# Reaper Optimization Frame",
    "This frame is persistent task memory. Do not summarize it away or override it with local temptations.",
    "",
    "Primary objective:",
    input.prompt.slice(0, 1200),
    "",
    "Current scope anchor:",
    input.currentStep ? stepText.slice(0, 1400) : "No current step. Stay anchored to the primary objective and visible acceptance criteria.",
    "",
    "Non-goals unless directly required by the current objective:",
    "- Dependency upgrades, formatter/lint cleanup, broad refactors, framework migrations, architecture rewrites, unrelated warnings, unrelated legacy failures.",
    "- Reinstalling or rebuilding environments without concrete evidence that the environment is the blocker.",
    "- Expanding edits outside the target dependency radius without explicit evidence.",
    "",
    "Execution policy:",
    "- Prefer the smallest task-facing change that advances the visible success conditions.",
    "- After a failed build/test/runtime check, classify the failure before acting: task-blocking, preexisting, environmental, non-critical warning, transient, or unrelated legacy noise.",
    "- If a warning or legacy failure is not blocking the requested task, record it and keep moving.",
    "- Do not repeat the same command, same edit, or same read-only diagnosis without a materially new hypothesis.",
    "- For implementation steps, after a small amount of diagnosis, edit or run a targeted check. Repeated searching/reading is drift.",
    "- Use targeted tests first, then escalate only when local evidence passes.",
    "- Keep terminal output small: run narrow commands and focus on exit code, error class, failing file/test, stack frame, and key stderr.",
    "- Before complete_task, verify scope, minimality, task alignment, and that any server/process you started has been stopped when no longer needed.",
    "",
    "Current trajectory metrics:",
    JSON.stringify(metrics),
    "",
    renderCommandStateLedger(input.toolResults),
    "",
    recentTouchedFiles.length ? `Recently touched files:\n${recentTouchedFiles.map((file) => `- ${file}`).join("\n")}` : "Recently touched files: none",
    "",
    latestFailureSummary ? `Latest failure summary:\n${renderToolResultForModel(latestFailureSummary, { compact: true, maxOutputChars: 1800 })}` : "Latest failure summary: none",
    "",
    repeatedFailure
      ? `Repeated failure signature detected:\n${JSON.stringify(repeatedFailure)}\nDo not retry the same trajectory. Change strategy or scope the patch.`
      : "Repeated failure signature detected: none",
    "",
    input.feedback.length ? `Active feedback:\n${input.feedback.slice(-6).map((item) => `- ${item}`).join("\n")}` : "Active feedback: none",
    "",
    input.negativeConstraints.length
      ? `Attempt memory / do-not-repeat:\n${input.negativeConstraints.slice(-10).map((item) => `- ${item}`).join("\n")}`
      : "Attempt memory / do-not-repeat: none",
  ].join("\n");
}

export function buildLiveOptimizationSnapshot(results: ToolResult[]): Record<string, unknown> {
  const recent = results.slice(-40);
  const commandResults = recent.filter((result) => result.name === "run_shell_command");
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

function renderCommandStateLedger(results: ToolResult[]): string {
  const commands = results
    .filter((result) => result.name === "run_shell_command")
    .slice(-16)
    .map((result) => {
      const command = getToolResultCommand(result);
      const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
      const exitCode = output.exitCode;
      const status = result.ok ? "ok" : `failed:${result.error?.code ?? "error"}`;
      const stdout = typeof output.stdout === "string" ? summarizeCommandStream(output.stdout) : "";
      const stderr = typeof output.stderr === "string" ? summarizeCommandStream(output.stderr) : "";
      const error = result.error?.message ? summarizeCommandStream(result.error.message) : "";
      return [
        `- ${status} exit=${exitCode ?? "n/a"} cmd=${command}`,
        stdout ? `  stdout: ${stdout}` : "",
        stderr ? `  stderr: ${stderr}` : "",
        error ? `  error: ${error}` : "",
      ].filter(Boolean).join("\n");
    });
  const repeated = getRepeatedCommandLedger(results);
  return [
    "Recent command ledger:",
    "Each item below is an EXECUTION RESULT from a command Reaper already ran.",
    commands.length ? commands.join("\n") : "- none",
    "",
    repeated.length ? `Repeated command counts:\n${repeated.map(({ command, count }) => `- ${count}x ${command}`).join("\n")}` : "Repeated command counts: none",
    "",
    "Command-state rule: this ledger is authoritative. Do not rerun a command shown here unless a concrete file/config/env change after that command could change its result. If a setup/install command already succeeded but the runtime check still fails, stop reinstalling and inspect/fix path, wrapper, script, import, or test environment instead.",
  ].join("\n");
}

export function summarizeCommandStream(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ")
    .slice(0, 700);
}

export function getRepeatedCommandLedger(results: ToolResult[]): Array<{ command: string; count: number }> {
  const counts = new Map<string, number>();
  for (const result of results.filter((item) => item.name === "run_shell_command")) {
    const command = normalizeCommandForSignature(getToolResultCommand(result));
    if (!command) continue;
    const key = canonicalizeCommandForLoopLedger(command);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([command, count]) => ({ command, count }));
}

function canonicalizeCommandForLoopLedger(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (/\bpython(?:3)?\s+-m\s+ensurepip\b/i.test(normalized)) return "python -m ensurepip";
  if (/\bpython(?:3)?\s+-m\s+pip\s+install\b/i.test(normalized)) return normalized.replace(/\bpython3?\b/i, "python");
  if (/\bpip(?:3)?\s+install\b/i.test(normalized)) return normalized.replace(/\bpip3\b/i, "pip");
  if (/\bpip(?:3)?\s+--version\b/i.test(normalized)) return "pip --version";
  return normalized;
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
      .filter((result) => ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name))
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
  const commandResults = toolResults.filter((result) => result.name === "run_shell_command");
  const failed = toolResults.filter((result) => !result.ok);
  const commands = commandResults.map((result) => normalizeCommandForSignature(getToolResultCommand(result))).filter(Boolean);
  const uniqueCommands = new Set(commands);
  const editedFiles = uniqueStrings(
    toolResults
      .filter((result) => ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(result.name))
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

function maxOutputCharsForCompactResult(result: ToolResult): number {
  if (!result.ok) return 4000;
  if (result.name === "run_shell_command") return 6000;
  if (result.name === "read_file") return 4000;
  if (result.name === "write_file" || result.name === "replace_in_file") return 4000;
  return 4000;
}

function toolResultPath(result: ToolResult): string | undefined {
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
  return typeof output.path === "string" ? output.path : typeof args.path === "string" ? args.path : undefined;
}

function renderSessionTasksForPrompt(runId: string): string {
  const tasks = listSessionTasks(undefined, runId);
  if (tasks.length === 0) {
    return [
      "# Session Todo List",
      "(empty)",
      "If the user's request requires 3+ distinct steps, multi-file changes, or multiple features, your first action should be to decompose it with task_create. Skip the todo list only for single trivial actions.",
    ].join("\n");
  }
  const byStatus = { in_progress: [] as string[], pending: [] as string[], completed: [] as string[] };
  for (const t of tasks) {
    const line = `  - [${t.id}] ${t.subject}`;
    if (t.status === "in_progress") byStatus.in_progress.push(line);
    else if (t.status === "completed") byStatus.completed.push(line);
    else byStatus.pending.push(line);
  }
  const lines = ["# Session Todo List"];
  if (byStatus.in_progress.length > 0) {
    lines.push("In progress:");
    lines.push(...byStatus.in_progress);
  }
  if (byStatus.pending.length > 0) {
    lines.push("Pending:");
    lines.push(...byStatus.pending);
  }
  if (byStatus.completed.length > 0) {
    lines.push(`Completed: ${byStatus.completed.length} task(s)`);
  }
  const allDone = tasks.every((t) => t.status === "completed");
  if (allDone) {
    lines.push("All tasks are completed. If the user's full request is satisfied, emit complete_task with a summary. If new work has emerged, add it with task_create.");
  } else if (byStatus.in_progress.length === 0 && byStatus.pending.length > 0) {
    lines.push("No task is in_progress. Before any other tool call this turn, mark the next pending task in_progress with task_update.");
  } else if (byStatus.in_progress.length > 1) {
    lines.push("More than one task is in_progress. Reduce to exactly one in_progress task before continuing other work.");
  }
  return lines.join("\n");
}

export function renderAgentSourceReliabilityPatterns(role: "planner" | "executor" | "patcher" | "repair" | "recovery"): string {
  const common = [
    "# Agent Reliability Patterns",
    "Use repo-local instructions when they appear in indexed context, especially AGENTS.md, REAPER.md, CLAUDE.md, GEMINI.md, and .cursorrules. Treat them as project guidance unless they conflict with the user's request or higher-priority Reaper rules.",
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
    "Service lifecycle rule: a process/container being running is not readiness. After start/restart/recreate, use sandbox_service_control wait_ready with a bounded task-facing probe command; on crash/unhealthy/timeout, inspect the returned service logs before editing or retrying. If restart cannot repair an entrypoint or mount that has the wrong filesystem type, recreate the service once before changing strategy.",
    "Container layer rule: the mounted/container view is not proof of image contents. When a provided service entrypoint has the wrong filesystem type or appears missing, inspect_image and compare mounted versus image layers before writing. Prefer restore_from_image over authoring replacement dependency code.",
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

function renderRecedingHorizonPlanContext(input: {
  executionPlan?: ExecutionPlanStep[] | undefined;
  currentStepIndex?: number | undefined;
  completedStepIds?: string[] | undefined;
}): string {
  const plan = input.executionPlan ?? [];
  if (plan.length === 0) return "# Receding Horizon Plan\nnone";
  const completed = new Set(input.completedStepIds ?? []);
  const currentStepIndex = Math.max(0, input.currentStepIndex ?? 0);
  const parentPlan = plan.map((step, index) => {
    const status = completed.has(step.id)
      ? "completed"
      : index === currentStepIndex
        ? "current"
        : index < currentStepIndex
          ? "past_unconfirmed"
          : "remaining";
    return {
      index,
      id: step.id,
      title: step.title,
      type: step.type,
      status,
      instructions: step.instructions.slice(0, 700),
      successCriteria: step.successCriteria?.slice(0, 5),
      testGuidance: step.testGuidance?.slice(0, 500),
    };
  });
  return [
    "# Receding Horizon Plan",
    "Keep the current step aligned with this parent plan. After completing the current step, preserve verified work and refine only the remaining steps from evidence.",
    JSON.stringify({
      total_steps: plan.length,
      current_step_index: currentStepIndex,
      completed_step_ids: [...completed],
      parent_plan: parentPlan,
    }),
  ].join("\n");
}

export function isMutatingToolCall(call: ToolCall): boolean {
  if (call.name === "sandbox_service_control") {
    return ["exec", "write_file", "copy_to_service", "restore_from_image", "restart", "start", "stop"].includes(call.args.action);
  }
  return call.name === "write_file" || call.name === "edit_file" || call.name === "replace_in_file" || call.name === "replace_symbol" || call.name === "delete_file";
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

function buildStepExecutionPrompt(input: {
  prompt: string;
  contentPrep: ContentPrepResult;
  step: ExecutionPlanStep;
  isFinalPlanStep: boolean;
  executionPlan?: ExecutionPlanStep[] | undefined;
  currentStepIndex?: number | undefined;
  completedStepIds?: string[] | undefined;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  blockingFacts?: RuntimeBlockingFacts;
  deadlinePressure?: RuntimeDeadlinePressure;
  runId: string;
}): string {
  // Long-horizon context engineering: when the tool result history has grown
// large, switch to compact (path/exit/summary only) instead of full output
// re-injection. The model can re-run read_file / grep_search when it actually
// needs the exact content. Cuts the "Recent Tool Results" section from ~26KB
// to ~3KB on long tasks without losing the model-oriented signal.
  const recentResults =
    input.toolResults.length > 8
      ? renderRecentToolResultsForPromptCompact(input.toolResults, input.feedback, 3)
      : renderRecentToolResultsForPrompt(input.toolResults, input.feedback, 3);
  const compactedHistory = input.contentPrep.compactedHistory.compacted.slice(-4).join("\n");
  const fileTree = input.contentPrep.preparedContext.fileTree.slice(0, 80).join("\n");
  const context = input.contentPrep.preparedContext.chunks
    .slice(0, 3)
    .map((chunk) => chunk.content.slice(0, 1600))
    .join("\n\n---\n\n");
  const environment = renderFingerprintForPrompt(input.contentPrep.environmentFingerprint);

  return [
    "# Reaper Step Executor",
    "A durable plan already exists. Do not replan the whole task.",
    "Return ONLY JSON with shape {\"assistant_message\": string, \"tool_calls\": ToolCall[]}.",
    renderToolCallContract(input.runId),
    "For intermediate steps, assistant_message must be an empty string. The only task summary belongs in complete_task.args.summary at the end.",
    "Generate as many tool calls as the current step needs to complete, then emit advance_step. The model drives the step end-to-end. Reaper does not artificially split a step across multiple model responses.",
    "Only break a step across responses when a real failure (parse error, tool error, blocker) prevents further progress. A successful tool result is not a reason to stop; continue the step until the success criteria are met.",
    "Keep JSON payloads small. Do not emit huge source files in one response. For generated implementation files, create a compact minimal version first, then add behavior through smaller follow-up edits after compilation/runtime feedback.",
    "Generated artifact chunking rule: if any write_file was rejected as incomplete/truncated, or a structured response fallback appeared, do not retry a large full-file payload. Write the smallest complete compiling/runnable artifact first, then extend it with focused replace_in_file/edit_file chunks and a narrow check. This rule is language-agnostic.",
    "Context budget rule: if recent tool output says content was compacted or omitted, do not ask for the full file by default. Use grep_search or bounded read_file ranges around the cited symbol, line, stack frame, test, or diagnostic.",
    "You control step advancement. If this current step is complete but the whole task is not complete, emit advance_step with concrete evidence in the same response. Reaper will not auto-advance from successful tools.",
    "If the whole requested task is complete, emit complete_task with a final model-written summary. Reaper will exit on that signal.",
    input.isFinalPlanStep
      ? "This is the FINAL planned step. If this step completes the requested task, emit complete_task with args.summary instead of advance_step. Reaper exits immediately after complete_task."
      : "This is not the final planned step. Use advance_step when this step is complete and the whole task still has later steps.",
    "If this is the final plan step and you return no tool_calls or only advance_step, Reaper will ask for complete_task or concrete remaining work.",
    "Do not emit complete_task until your testing step has run a real build/test/lint/runtime smoke check or testing is explicitly unavailable with evidence. Placeholder commands such as echo success, true, or exit 0 are not testing.",
    "",
	    renderOptimizationFrame({
	      prompt: input.prompt,
	      currentStep: input.step,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	      mode: "executor",
	    }),
	    "",
	    renderEpicStateForPrompt({
	      runId: input.runId,
	      prompt: input.prompt,
	      executionPlan: input.executionPlan,
	      currentStepIndex: input.currentStepIndex,
	      completedStepIds: input.completedStepIds,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	    }),
	    "Executor authority: you may edit files, create files, run commands, and perform normal planned implementation work for the current planner step.",
    "Repair rule: if execution reveals a bug, failing test, regression, or compatibility problem, keep ownership in the main coding agent. Make the smallest safe repair directly, or call an advisory subagent for review/research while the main agent remains responsible for edits and verification.",
    "Do not delegate repair control flow to a hidden patcher. Keep edits and verification in the main coding agent path.",
    "",
    renderAgentSourceReliabilityPatterns("executor"),
    "",
    "# Tool Selection",
    renderSessionTasksForPrompt(input.runId),
    "",
    "# Task Tracking (task_create / task_update / task_list)",
    "Use the session todo list to decompose and track work. The current list is shown above and refreshes every turn.",
    "When to use:",
    "  - The user's request requires 3+ distinct steps, touches multiple files, or implements multiple features.",
    "  - You just received new instructions: capture the requirements as tasks immediately, before any other tool calls.",
    "  - You discover new work mid-task: append it with task_create.",
    "When NOT to use: a single trivial action (one read, one edit, one shell command).",
    "Status discipline:",
    "  - Mark a task in_progress BEFORE beginning work on it. Exactly ONE task should be in_progress at any time.",
    "  - Mark a task completed IMMEDIATELY after finishing it. Do not batch completions across turns.",
    "  - Never mark a task completed if tests are failing, implementation is partial, or you hit an unresolved error. Keep it in_progress and add a new task describing the blocker.",
    "Completion gate: do not emit complete_task while pending or in_progress tasks remain. Either finish them, or remove them with task_update if they became irrelevant.",
    "Use specific tools for file work: read_file, list_directory, grep_search, skim_file, inspect_environment, write_file, replace_in_file, edit_file, replace_symbol, delete_file.",
    "Use run_shell_command only for installs, builds, tests, server/process commands, runtime checks, or when a specific tool cannot express the operation.",
    "For dependency discovery, run package-specific checks instead of dumping directories: npm ls <package>, npm view <package> version, node -e \"require.resolve('<package>')\", python -m pip show <package>, cargo tree -p <package>, go list -m <module>, or equivalent for the active ecosystem.",
    "Use the package manager for the active ecosystem only. Do not install a C/C++ header or source library with npm/pnpm/yarn; do not install JavaScript packages with pip/cargo/go. For header-only/source-only dependencies, prefer existing vendored files, system packages, documented direct source/header downloads, or a small local implementation when that satisfies the task.",
    "Do not use broad recursive listings for dependency discovery. If structure is needed, use list_directory or a pruned command that excludes dependency/build/cache directories.",
    "If a build cache points at a different source root/configuration, remove only the task-local build/cache directory and reconfigure from the intended source root before retrying. This is allowed cleanup, not destructive source deletion.",
    "For build systems, first identify the actual build-file location. For CMake, run cmake -S <directory-with-CMakeLists.txt> -B <task-local-build-dir>; do not run cmake from a parent directory without CMakeLists.txt.",
    "Acceptance-first implementation: before writing complex parsing/business logic, inspect the visible spec/tests and implement the smallest real behavior that satisfies them. Avoid deep legacy rewrites unless tests/specs require that fidelity.",
    "For brittle legacy/vendor/generated code, prefer non-invasive adapters, wrappers, standalone converters, compatibility headers, or small shims. Do not repeatedly patch legacy internals when a wrapper or standalone implementation can satisfy the current step and tests.",
    "Optional exploratory checks must not become the task. If a demo/sample/generated diagnostic harness fails and it is not an official/user acceptance check or required deliverable, capture the evidence, skip/advance, and continue producing the primary artifacts.",
    "For long-running servers, use managed background execution, verify with curl/tests, then call signal_process to stop the server once the check is complete.",
    "Before mutating an existing file, read it first. New files may be created directly with write_file.",
    "When an exact replacement fails or a file changed since the last read, read the file again and prefer a line-range replacement for the smallest affected region. Do not retry stale exact text.",
    "When changing calls/APIs/syntax, preserve required operands/arguments. Do not blindly rename or reorder function/operator calls if the replacement has a different argument order or shape; edit the full affected lines/region and run a narrow syntax/build check.",
    "For quick runtime/import/compile checks, prefer non-destructive one-off commands from the workspace root. If you create a temporary check file, resolve imports/paths relative to that file and runtime, not by assumption.",
    "Run test/check commands at subsystem boundaries when this step creates testable code, then emit advance_step only if the check passed or the step has concrete evidence.",
    "Test setup is not complete until the task-local test/check command is runnable and discovers at least one real test/smoke file. Placeholder scripts and test files without a matching command are not progress.",
    "For complex application tasks, build-only checks are not enough before complete_task. Add a behavioral test/smoke check for the requested workflow before completion.",
    "When a compile/build/test/runtime command reports diagnostics, inspect the exact referenced file/config/log, edit the real cause, and rerun the smallest relevant check. For larger uncertainty, call an advisory subagent but keep main-agent ownership.",
    "For case-sensitive include/source path failures, if the referenced path differs only by filename casing from an existing file, either update the include with a precise line-range edit or create a tiny compatibility wrapper file at the exact referenced path that includes the existing file.",
    "If build/test/runtime is currently failing because of a bug or compatibility issue, preserve the failing command/error logs as evidence, repair directly, and rerun the check until it passes.",
    "If a test command times out or reports open handles, do not rerun the full suite unchanged. First inspect the failing hook/test file and app/database startup code, then run a narrow single-file diagnostic with single-worker/open-handle flags when available. For database-backed tests, prefer an isolated in-process/mocked/file-backed test service or a short connection/server-selection timeout over assuming an external daemon is running.",
    "For targeted npm tests, inspect package.json and run the actual test runner directly or use 'npm test -- <path>' only when the script forwards arguments. Do not use 'npm test <path>' blindly.",
    "Test imports must not start long-running servers as side effects. Export app/module construction separately from process startup and guard listen/start code behind the language's main-entry check.",
    "Do not assume external services such as databases or caches are running. Check availability first; if unavailable and Docker is unavailable, use a test-safe in-process, file-backed, mocked, or static verification path.",
    "Never cd to or install into the host repository root. Commands start in the task workspace; use relative paths or $WORKSPACE only.",
    "If the environment says Docker is unavailable, do not run docker/docker-compose. Create or inspect Docker files and validate them statically instead.",
    "",
    "# Overall Task",
    input.prompt,
    "",
    "# Current Step",
    JSON.stringify({
      id: input.step.id,
      title: input.step.title,
      isFinalPlanStep: input.isFinalPlanStep,
      instructions: input.step.instructions,
      type: input.step.type,
      onFailure: input.step.onFailure,
      suggestedImplementation: input.step.suggestedImplementation,
      testGuidance: input.step.testGuidance,
    }),
    "",
	    renderRecedingHorizonPlanContext({
	      executionPlan: input.executionPlan,
	      currentStepIndex: input.currentStepIndex,
	      completedStepIds: input.completedStepIds,
	    }),
    "",
    "# Workspace",
    fileTree || "(empty)",
    "",
    `# Environment\n${environment}`,
    "",
    renderRuntimeDeadlinePressure(input.deadlinePressure),
    "",
    compactedHistory ? `# Compacted Observations\n${compactedHistory}` : "# Compacted Observations\nnone",
    "",
    `# Relevant Context\n${context || "(no indexed context)"}`,
    "",
    `# Recent Tool Results\n${JSON.stringify(recentResults)}`,
    "",
    renderCompilerDiagnosticGuidance(input.toolResults),
    "",
    renderApiMismatchRecoveryGuidance(input.toolResults),
    "",
    renderDiagnosticTargeting(input.toolResults),
    "",
    renderRuntimeBlockingFacts(input.blockingFacts),
    "",
    renderArtifactObligationLedger(input.prompt, input.toolResults),
    "",
    renderContractCoverageMatrix(input.prompt, input.toolResults),
    "",
    input.feedback.length ? `# Verification Feedback\n${capFeedbackForContext(input.feedback).join("\n\n---\n\n")}` : "# Verification Feedback\nnone",
    "",
    input.negativeConstraints.length
      ? `# Do Not Repeat\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "# Do Not Repeat\nNo negative constraints recorded.",
  ].join("\n\n");
}

function buildAutonomousRepairPrompt(input: {
  prompt: string;
  contentPrep: ContentPrepResult;
  currentStep?: ExecutionPlanStep;
  executionPlan?: ExecutionPlanStep[] | undefined;
  currentStepIndex?: number | undefined;
  completedStepIds?: string[] | undefined;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  blockingFacts?: RuntimeBlockingFacts;
  deadlinePressure?: RuntimeDeadlinePressure;
  runId: string;
}): string {
  const recentResults = renderRecentToolResultsForPromptCompact(input.toolResults, input.feedback, 8);
  const fileTree = input.contentPrep.preparedContext.fileTree.slice(0, 160).join("\n");
  const environment = renderFingerprintForPrompt(input.contentPrep.environmentFingerprint);
  return [
    "# Reaper Repair Pass",
    "A durable execution plan is already in progress. Do not replan the whole task.",
    "Return ONLY JSON with shape {\"assistant_message\": string, \"tool_calls\": ToolCall[]}.",
    renderToolCallContract(input.runId),
    "For repairs, assistant_message must be an empty string. The only task summary belongs in complete_task.args.summary at the end.",
    "Provide the smallest concrete tool-call batch that repairs the failed step or failed build/test/runtime check.",
    "Generated artifact chunking rule: if any write_file was rejected as incomplete/truncated, or a structured response fallback appeared, do not retry a large full-file payload. Write the smallest complete compiling/runnable artifact first, then extend it with focused replace_in_file/edit_file chunks and a narrow check. This rule is language-agnostic.",
    "Context budget rule: if recent tool output says content was compacted or omitted, do not ask for the full file by default. Use grep_search or bounded read_file ranges around the cited symbol, line, stack frame, test, or diagnostic.",
    "If the repair confirms the whole requested task is complete, emit complete_task with a final model-written summary so Reaper exits.",
    "Do not emit complete_task until your testing step has run a real build/test/lint/runtime smoke check or testing is explicitly unavailable with evidence. Placeholder commands such as echo success, true, or exit 0 are not testing.",
    "",
	    renderOptimizationFrame({
	      prompt: input.prompt,
	      currentStep: input.currentStep,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	      mode: "repair",
	    }),
	    "",
	    renderEpicStateForPrompt({
	      runId: input.runId,
	      prompt: input.prompt,
	      executionPlan: input.executionPlan,
	      currentStepIndex: input.currentStepIndex,
	      completedStepIds: input.completedStepIds,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	    }),
	    "",
    renderAgentSourceReliabilityPatterns("repair"),
    "If the task-local test/check script is missing or placeholder, repair it as part of the model-managed testing step: inspect the manifest/build config, replace placeholder scripts with a real command, ensure a matching test/smoke file exists, install only the missing runner needed for that command, then run it.",
    "If only build/static checks exist for a complex app, add or run a behavioral smoke/test check for the requested workflow before complete_task.",
    "If a server/background process was started only for a check, stop it with signal_process after the check succeeds or fails.",
    "Do not repeat an identical failing command or edit.",
    "Use failure output diagnostically: read the referenced artifact, repair the root cause, then rerun the smallest relevant check. This applies to any language, framework, or toolchain.",
    "Do not repair optional exploratory/demo/sample harness failures unless they directly block a required user acceptance check. Prefer returning to the primary deliverable path.",
    "If a compiler/runtime diagnostic cites a missing or invalid include/import/module, the repair must remove or replace that exact failing reference from the active load/compile path. Do not create a wrapper/shim that still contains the same failing include/import.",
    "",
    "# Current Step",
    input.currentStep
      ? JSON.stringify({
          id: input.currentStep.id,
          title: input.currentStep.title,
          instructions: input.currentStep.instructions,
        })
      : "No current step is available; repair the latest failure and move toward completion.",
    "",
    renderRecedingHorizonPlanContext({
      executionPlan: input.executionPlan,
      currentStepIndex: input.currentStepIndex,
      completedStepIds: input.completedStepIds,
    }),
    "",
    "# Task",
    input.prompt,
    "",
    "# File Tree",
    fileTree || "(empty)",
    "",
    `# Environment\n${environment}`,
    "",
    renderRuntimeDeadlinePressure(input.deadlinePressure),
    "",
    "# Recent Tool Results",
    JSON.stringify(recentResults),
    "",
    renderCompilerDiagnosticGuidance(input.toolResults),
    "",
    renderApiMismatchRecoveryGuidance(input.toolResults),
    "",
    renderDiagnosticTargeting(input.toolResults),
    "",
    renderRuntimeBlockingFacts(input.blockingFacts),
    "",
    renderArtifactObligationLedger(input.prompt, input.toolResults),
    "",
    renderContractCoverageMatrix(input.prompt, input.toolResults),
    "",
    "# Tool Fallback Rule",
    "Prefer the specific Reaper tool for reads/lists/searches/writes/edits/deletes/task tracking. Use run_shell_command only when the specific tool failed, cannot express the required operation, or local verification/install/runtime execution is needed.",
    "For dependency discovery, use targeted package checks such as npm ls <package>, npm view <package> version, node -e \"require.resolve('<package>')\", python -m pip show <package>, cargo tree -p <package>, go list -m <module>, or the ecosystem equivalent. Do not inspect all dependency directories.",
    "Use the package manager for the active ecosystem only. Do not install a C/C++ header or source library with npm/pnpm/yarn; do not install JavaScript packages with pip/cargo/go. Prefer existing vendored files, system packages, documented direct source/header downloads, or a small local implementation when enough.",
    "If a build cache points at a different source root/configuration, remove only the task-local build/cache directory and reconfigure from the intended source root before retrying.",
    "If a write_file result reports stale_write_requires_read or says the file must be read before editing, do not retry write_file immediately. The next call for that path must be read_file; after the read succeeds, use replace_in_file/edit_file for targeted edits or write_file only for an intentional full overwrite.",
    "When an exact replacement fails or a file changed since the last read, read the file again and prefer a line-range replacement for the smallest affected region. Do not retry stale exact text.",
    "When changing calls/APIs/syntax, preserve required operands/arguments. Do not blindly rename or reorder function/operator calls if the replacement has a different argument order or shape; edit the full affected lines/region and run a narrow syntax/build check.",
    "For missing-module/import/path failures, do not retry the same command. Inspect the error, the executing file, the command working directory, and the language/runtime path resolution rules before generating the next command.",
    "For case-sensitive include/source path failures, if the referenced path differs only by filename casing from an existing file, either update the include with a precise line-range edit or create a tiny compatibility wrapper file at the exact referenced path that includes the existing file.",
    "For test open handles/timeouts caused by startup side effects, separate app/module export from server/process startup and close external resources in teardown. Do not only increase timeouts.",
    "After two broad test-suite timeout/open-handle failures, stop running broad test commands. Inspect the timed-out hook/test file and run a single-file diagnostic with single-worker/open-handle flags or repair the external service dependency with an isolated/mocked/file-backed test setup.",
    "If a local external service/database connection is refused and Docker is unavailable, switch to an in-process/file-backed/mocked/static verification strategy instead of retrying the same unavailable service.",
    "",
    input.feedback.length ? `# Verification Feedback\n${capFeedbackForContext(input.feedback).join("\n\n---\n\n")}` : "# Verification Feedback\nnone",
    "",
    input.negativeConstraints.length
      ? `# Do Not Repeat\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "# Do Not Repeat\nNo negative constraints recorded.",
  ].join("\n\n");
}

function buildSimplifyRecoveryPrompt(input: {
  prompt: string;
  contentPrep: ContentPrepResult;
  currentStep?: ExecutionPlanStep;
  executionPlan?: ExecutionPlanStep[] | undefined;
  currentStepIndex?: number | undefined;
  completedStepIds?: string[] | undefined;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  blockingFacts?: RuntimeBlockingFacts;
  blockedPaths: string[];
  deadlinePressure?: RuntimeDeadlinePressure;
  runId: string;
}): string {
  const recentResults = renderRecentToolResultsForPromptCompact(input.toolResults, input.feedback, 14);
  const fileTree = input.contentPrep.preparedContext.fileTree.slice(0, 180).join("\n");
  const environment = renderFingerprintForPrompt(input.contentPrep.environmentFingerprint);
  return [
    "# Reaper Simplify Recovery",
    "The normal execution/repair loop is showing repeated churn. This recovery mode follows the cc-haha style of verify-then-simplify: stop broad retries, use constrained evidence, and choose the smallest implementation path that satisfies the task.",
    "Return ONLY JSON with shape {\"assistant_message\": string, \"tool_calls\": ToolCall[]}.",
    renderToolCallContract(input.runId),
    "For this recovery pass, assistant_message must be an empty string unless you emit complete_task.",
    "",
    "# Hard Recovery Rules",
	    renderOptimizationFrame({
	      prompt: input.prompt,
	      currentStep: input.currentStep,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	      mode: "repair",
	    }),
	    "",
	    renderEpicStateForPrompt({
	      runId: input.runId,
	      prompt: input.prompt,
	      executionPlan: input.executionPlan,
	      currentStepIndex: input.currentStepIndex,
	      completedStepIds: input.completedStepIds,
	      toolResults: input.toolResults,
	      feedback: input.feedback,
	      negativeConstraints: input.negativeConstraints,
	    }),
    "",
    renderAgentSourceReliabilityPatterns("recovery"),
    "",
    "- Do not replan the whole task.",
    "- Do not repeat the same failed command or edit.",
    "- Do not continue patching brittle internals after repeated build/compile failures.",
    "- Do not edit blocked/overpatched paths unless a single bounded read proves one tiny line-range edit is the only viable fix.",
    "- Prefer a wrapper, adapter, compatibility shim, generated output, or small standalone implementation that is scoped to the requested acceptance criteria.",
    "- If a built executable/runtime crashes after repeated internal patches, stop debugging internals by default. Replace or wrap the crashing boundary with a crash-free implementation that preserves the required command/API/output contract, then verify that boundary.",
    "- If the requested deliverable is files, generated artifacts, reports, converted data, migrations, or other outputs, and internal implementation is stuck, create the required deliverables directly from the visible task contract/tests/specs. Do not keep perfecting internals that are not externally required.",
    "- Artifact-first recovery is not a shortcut to fake success: outputs must match the visible contract and must be checked with the real validation command or a narrow equivalent.",
    "- Inspect visible specs/tests/validation scripts when needed, then act. Do not read the same files repeatedly.",
    "- Produce 1 to 6 concrete tool calls. Do not return an empty tool_calls array. Include a narrow real build/test/runtime check when possible.",
    "- If generated source/config/data was rejected as incomplete/truncated, do not retry a large full-file write. Create the smallest complete artifact that can run or be checked, then grow it through small targeted edits.",
    "- If recent tool output was compacted for context budget, use grep_search or bounded read_file ranges around cited symbols/lines instead of reading whole files again.",
    "- Do not use hidden repair routing. Complete the smallest boundary fix directly or gather one missing piece of evidence.",
    "- Use advance_step only when the current step criteria are satisfied with evidence.",
    "- Use complete_task only when the whole user task is done and a real check has passed or unavailable testing is documented by evidence.",
    "- If a server/background process was started only for testing, stop it with signal_process after the check.",
    "",
    "# Current Step",
    input.currentStep
      ? JSON.stringify({
          id: input.currentStep.id,
          title: input.currentStep.title,
          instructions: input.currentStep.instructions,
          successCriteria: input.currentStep.successCriteria,
          suggestedImplementation: input.currentStep.suggestedImplementation,
          testGuidance: input.currentStep.testGuidance,
        })
      : "No current step is available; recover from the latest failed evidence and move toward completion.",
    "",
    renderRecedingHorizonPlanContext({
      executionPlan: input.executionPlan,
      currentStepIndex: input.currentStepIndex,
      completedStepIds: input.completedStepIds,
    }),
    "",
    "# Task",
    input.prompt,
    "",
    "# Blocked Or Overpatched Paths",
    input.blockedPaths.length ? input.blockedPaths.map((filePath) => `- ${filePath}`).join("\n") : "none recorded",
    "",
    "# File Tree",
    fileTree || "(empty)",
    "",
    `# Environment\n${environment}`,
    "",
    renderRuntimeDeadlinePressure(input.deadlinePressure),
    "",
    "# Recent Tool Results",
    JSON.stringify(recentResults),
    "",
    renderCompilerDiagnosticGuidance(input.toolResults),
    "",
    renderApiMismatchRecoveryGuidance(input.toolResults),
    "",
    renderDiagnosticTargeting(input.toolResults),
    "",
    renderRuntimeBlockingFacts(input.blockingFacts),
    "",
    renderArtifactObligationLedger(input.prompt, input.toolResults),
    "",
    renderContractCoverageMatrix(input.prompt, input.toolResults),
    "",
    "# Recovery Strategy",
    "Use the evidence to pivot to the smallest reliable acceptance-first path. For example, if a vendor/legacy/generated dependency is consuming many repairs, create a thin adapter or standalone executable/API at the boundary the tests or user actually require, and verify that boundary. This rule is language-agnostic: apply it to C/C++, Python, JavaScript, Go, Rust, Java, or any other ecosystem.",
    "If tests/specs define exact output or behavior, satisfy that externally visible contract instead of continuing an internal migration that is not required by the acceptance criteria.",
    "",
    "# Tool Fallback Rule",
    "Prefer specific Reaper tools for reads/lists/searches/writes/edits/deletes/task tracking. Use run_shell_command for installs, directory creation, builds, tests, runtimes, and shell-only operations.",
    "",
    input.feedback.length ? `# Verification Feedback\n${capFeedbackForContext(input.feedback).join("\n\n---\n\n")}` : "# Verification Feedback\nnone",
    "",
    input.negativeConstraints.length
      ? `# Do Not Repeat\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "# Do Not Repeat\nNo negative constraints recorded.",
  ].join("\n\n");
}

function getRuntimeDeadlinePressure(startedAt: number): RuntimeDeadlinePressure {
  const deadlineMs = getRuntimeDeadlineMs();
  const elapsedMs = Date.now() - startedAt;
  if (!deadlineMs) {
    return { active: false, critical: false, elapsedMs };
  }
  const remainingMs = Math.max(0, deadlineMs - elapsedMs);
  const ratio = elapsedMs / deadlineMs;
  const active = ratio >= 0.65;
  const critical = ratio >= 0.82 || remainingMs <= 180_000;
  if (!active) {
    return { active: false, critical: false, elapsedMs, deadlineMs, remainingMs };
  }
  const minutesLeft = Math.max(0, Math.round(remainingMs / 60_000));
  return {
    active,
    critical,
    elapsedMs,
    deadlineMs,
    remainingMs,
    feedback: [
      critical ? "Runtime deadline is critical." : "Runtime deadline pressure is active.",
      `Approximate time remaining: ${minutesLeft} minute(s).`,
      "Switch to acceptance-first execution: produce required artifacts/outputs, run the narrowest real validation, and emit complete_task only after evidence. Avoid broad rewrites, repeated inspection, or large generated source payloads.",
    ].join(" "),
    negativeConstraint:
      "Do not spend deadline-critical time on broad refactors, dependency upgrades, repeated reads, or deep internals unless they directly block the visible acceptance artifact/check.",
  };
}

function getRuntimeDeadlineMs(): number | undefined {
  const candidates = [
    process.env.REAPER_RUN_DEADLINE_MS,
    process.env.REAPER_AGENT_TIMEOUT_MS,
    process.env.REAPER_TBENCH_TIMEOUT_SEC ? String(Number(process.env.REAPER_TBENCH_TIMEOUT_SEC) * 1000) : undefined,
    process.env.REAPER_TBENCH_AGENT_TIMEOUT_SEC ? String(Number(process.env.REAPER_TBENCH_AGENT_TIMEOUT_SEC) * 1000) : undefined,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function isStructuredResponseFallbackMessage(message: string): boolean {
  return /previous model response was truncated or invalid/i.test(message);
}

function hasRecentStructuredResponseFallbackFeedback(feedback: string[]): boolean {
  return feedback.slice(-4).some((entry) => /truncated\/invalid structured model response|model response was truncated or invalid/i.test(entry));
}

function hasRepeatedStructuredResponseFallbackFeedback(feedback: string[]): boolean {
  return feedback
    .slice(-6)
    .some((entry) => /repeated truncated\/invalid structured model responses|truncated or invalid again|replan now into smaller executable steps/i.test(entry));
}

function hasRecentIncompleteGeneratedArtifact(results: ToolResult[]): boolean {
  return results.slice(-10).some((result) => {
    if (result.ok) return false;
    return (
      result.error?.code === "incomplete_source_write" ||
      /appears truncated or syntactically incomplete|partial full-file writes/i.test(result.error?.message ?? "")
    );
  });
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

function renderRuntimeDeadlinePressure(pressure?: RuntimeDeadlinePressure): string {
  if (!pressure?.active) return "# Runtime Deadline Pressure\nnone";
  return [
    "# Runtime Deadline Pressure",
    pressure.critical ? "critical" : "active",
    `elapsedMs=${pressure.elapsedMs}`,
    pressure.deadlineMs !== undefined ? `deadlineMs=${pressure.deadlineMs}` : "",
    pressure.remainingMs !== undefined ? `remainingMs=${pressure.remainingMs}` : "",
    pressure.feedback ?? "",
  ].filter(Boolean).join("\n");
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
    "Use run_shell_command for installs, mkdir, scaffolding, tests, builds, and other shell-only operations.",
    "Do not create, edit, delete, chmod, copy, or redirect output into external verifier-owned absolute paths such as /tests or /test. Treat those harness files as read-only and satisfy their contract from workspace files.",
    "Use camelCase argument names exactly as shown. Do not use snake_case aliases, nested file objects, or keys such as command/new_content/from_lines/to_lines.",
    "For every run_shell_command, include args.summary with the concrete reason for running it now. Keep it short, e.g. \"check pip wrapper after ensurepip\" or \"run focused failing test\".",
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
    "- run_shell_command: {\"id\":\"shell-1\",\"name\":\"run_shell_command\",\"args\":{\"cmd\":\"npm install\",\"summary\":\"install declared project dependencies\"}}",
    "- run_shell_command background server: {\"id\":\"server-1\",\"name\":\"run_shell_command\",\"args\":{\"cmd\":\"npm run dev\",\"summary\":\"start app server for runtime check\",\"isBackground\":true,\"timeoutMs\":300000}}",
  ];

  if (fullSchemaTools.has("sandbox_service_control")) {
    lines.push(
      "- sandbox_service_control list: {\"id\":\"svc-list-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"list\"}}",
      "- sandbox_service_control logs: {\"id\":\"svc-logs-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"logs\",\"service\":\"service-name\",\"tail\":120}}",
      "- sandbox_service_control snapshot: {\"id\":\"svc-snap-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"snapshot\",\"service\":\"service-name\"}}",
      "- sandbox_service_control inspect_image: {\"id\":\"svc-image-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"inspect_image\",\"service\":\"service-name\"}}",
      "- sandbox_service_control restore_from_image: {\"id\":\"svc-restore-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"restore_from_image\",\"service\":\"service-name\",\"targetPath\":\"/app/server.py\"}}",
      "- sandbox_service_control exec: {\"id\":\"svc-exec-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"exec\",\"service\":\"service-name\",\"command\":\"cd /app && python3 server.py --check\",\"timeoutMs\":120000}}",
      "- sandbox_service_control write_file: {\"id\":\"svc-write-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"write_file\",\"service\":\"service-name\",\"targetPath\":\"/app/file.py\",\"content\":\"full file content\"}}",
      "- sandbox_service_control copy_to_service: {\"id\":\"svc-copy-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"copy_to_service\",\"service\":\"service-name\",\"sourcePath\":\"local/file.py\",\"targetPath\":\"/app/file.py\"}}",
      "- sandbox_service_control restart: {\"id\":\"svc-restart-1\",\"name\":\"sandbox_service_control\",\"args\":{\"action\":\"restart\",\"service\":\"service-name\"}}",
    );
  }

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
    "- complete_task: {\"id\":\"complete-1\",\"name\":\"complete_task\",\"args\":{\"summary\":\"final task completion summary\"}}",
    "- search_tools keyword: {\"id\":\"search-1\",\"name\":\"search_tools\",\"args\":{\"query\":\"background process\"}}",
    "- search_tools direct select: {\"id\":\"search-2\",\"name\":\"search_tools\",\"args\":{\"query\":\"select:read_background_output,signal_process\"}}",
    "To finish the run, emit complete_task exactly once with the final summary in args.summary, then no more tool calls are needed.",
    "Executor rule: normal planned implementation and repair both stay on the main coding agent path. Use advisory subagents only for extra analysis; they do not own routing or edits.",
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
    "- To create a directory, use run_shell_command with {\"cmd\":\"mkdir -p path/to/dir\"}.",
    "- To install dependencies, use run_shell_command with the real package-manager command for the active ecosystem, for example {\"cmd\":\"npm install express\"} only in a JavaScript/Node project.",
    "- To run create-vite or another scaffold non-interactively, include documented non-interactive flags or create files directly with write_file.",
    "",
    "Build/config path discipline:",
    "- If a build tool says a source/config file is missing, list/read the owning build config and the exact referenced path before rerunning the build.",
    "- Fix source/config path mismatches by either creating the file at the path referenced by the build config or updating the build config to the actual file path. Do not keep building from a directory that lacks the required config.",
    "- If a command fails because it was run from the wrong directory, rerun from the directory containing the relevant manifest/build config, or pass the build tool's explicit source/build directory flags.",
    "- If recent tool results include workspacePathAliases, treat those as equivalent roots. When writing scripts/configs that run through run_shell_command, embed the runtime/container path or a relative path, not the host scratch path.",
    "- Do not emit advance_step or complete_task after a failed build/test/runtime command unless a later command in the same or newer batch has passed and proves the step/task.",
    "- If a sandbox has sibling service containers, use sandbox_service_control for service logs, snapshots, file writes/copies, command execution, and restart/start/stop. Do not run docker through run_shell_command inside the task sandbox.",
  );

  return lines.join("\n");
}

function parseExecutionPlan(value: unknown): { plan: ExecutionPlanStep[]; assistant_message?: string } {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const sourcePlan = Array.isArray(raw.plan)
    ? raw.plan
    : Array.isArray(raw.steps)
      ? raw.steps
      : Array.isArray(raw.tool_calls)
        ? [{ id: "step-1", title: "Execute requested tool calls", instructions: "Run the planned tool calls.", tool_calls: raw.tool_calls }]
        : [];
  const plan = sourcePlan.flatMap((item, index): ExecutionPlanStep[] => {
    if (!item || typeof item !== "object") return [];
    const step = item as Record<string, unknown>;
    const toolCalls = parseToolCallArray(step.tool_calls, { context: `execution plan step ${index + 1}`, limit: 12 });
    return [
      {
        id: typeof step.id === "string" && step.id.trim() ? step.id : `step-${index + 1}`,
        title: typeof step.title === "string" && step.title.trim() ? step.title : `Step ${index + 1}`,
        instructions:
          typeof step.instructions === "string" && step.instructions.trim()
            ? step.instructions
            : "Execute these concrete tool calls.",
        ...(isPlanStepType(step.type) ? { type: step.type } : {}),
        ...(isPlanStepOnFailure(step.onFailure) ? { onFailure: step.onFailure } : {}),
        ...(typeof step.suggestedImplementation === "string" && step.suggestedImplementation.trim()
          ? { suggestedImplementation: step.suggestedImplementation }
          : {}),
        ...(typeof step.testGuidance === "string" && step.testGuidance.trim() ? { testGuidance: step.testGuidance } : {}),
        ...(Array.isArray(step.successCriteria)
          ? { successCriteria: step.successCriteria.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8) }
          : {}),
        agent: "executor" as const,
        tool_calls: toolCalls.slice(0, 12),
      },
    ];
  });
  if (plan.length === 0) {
    throw new Error("Planner output did not include any executable steps.");
  }
  const assistantMessage = typeof raw.assistant_message === "string" ? raw.assistant_message : undefined;
  return {
    plan: plan.slice(0, 20),
    ...(assistantMessage ? { assistant_message: assistantMessage } : {}),
  };
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

async function generateFinalSummary(input: {
  modelGateway?: ModelGateway;
  role: ModelRole;
  prompt: string;
  toolResults: ToolResult[];
  verification: RuntimeEngineResult["verification"] | undefined;
  completionSignalSummary?: string;
  stuckReason?: string;
}): Promise<string> {
  if (!input.modelGateway) return "Task ended before Reaper could request a model-authored final summary.";
  const recentResults = renderRecentToolResultsForPromptCompact(input.toolResults, [], 12);
  	  const result = await generateStructuredJson({
  	    modelGateway: input.modelGateway,
  	    role: input.role,
  	    maxTokens: 1024,
  	    system: buildSystemPromptForRole("recovery"),
  	    messages: [
      {
        role: "user",
        content: [
          "You are Reaper's final completion summarizer.",
          "Write the final user-facing completion summary in first person as the coding agent.",
          "Do not invent success. If verification failed or is missing, state the blocker concisely and what remains.",
          "Return ONLY JSON: {\"assistant_message\":\"...\"}",
          "",
          `USER TASK:\n${input.prompt.slice(0, 4000)}`,
          "",
          `VERIFICATION:\n${JSON.stringify(input.verification ?? { ok: false, failureClasses: ["missing_verification"] })}`,
          input.completionSignalSummary ? `\nMODEL COMPLETION SIGNAL SUMMARY:\n${input.completionSignalSummary}` : "",
          input.stuckReason ? `\nSTUCK REASON:\n${input.stuckReason}` : "",
          "",
          `RECENT TOOL RESULTS:\n${JSON.stringify(recentResults)}`,
        ].join("\n"),
      },
    ],
    parse: (value) => {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return { assistant_message: typeof raw.assistant_message === "string" ? raw.assistant_message : "" };
    },
  });
  return result.assistant_message.trim() || "Task ended without a model-authored completion summary.";
}

function summarizeExplicitToolRun(toolResults: ToolResult[]): string {
  const succeeded = toolResults.filter((result) => result.ok).length;
  const failed = toolResults.length - succeeded;
  const noun = toolResults.length === 1 ? "tool call" : "tool calls";
  return `Executed ${toolResults.length} ${noun}: ${succeeded} succeeded and ${failed} failed.`;
}

function buildModelCompletionPrompt(input: {
  prompt: string;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  completionGateAttempts: number;
  runId: string;
}): string {
  const recentResults = renderRecentToolResultsForPromptCompact(input.toolResults, input.feedback, 16);
  const completionBlocker = getCompletionBlocker(input.toolResults, input.runId, input.prompt);
  return [
    "# Reaper Model Completion Gate",
    "All planned steps are exhausted. Reaper automatic verification and automatic completion are disabled.",
    "You must decide whether the requested task is actually complete.",
    "Return ONLY JSON with shape {\"assistant_message\": string, \"tool_calls\": ToolCall[]}.",
    completionBlocker
      ? `Completion is currently blocked: ${completionBlocker}`
      : "If the task is complete, return exactly one complete_task tool call with a concise final completion summary in args.summary.",
    completionBlocker
      ? "Return concrete repair/check tool calls that directly clear the blocker. Do not emit complete_task while this blocker exists."
      : "If work remains, return concrete tool calls or an advance_step/repair step; do not claim completion.",
    input.completionGateAttempts > 0
      ? `You already reached this gate ${input.completionGateAttempts} time(s). Empty tool_calls is invalid here. Decide now: emit complete_task only with evidence, or emit concrete repair/check tool calls if not done.`
      : "Empty tool_calls is invalid at this gate because all planned steps are exhausted.",
    "",
    renderToolCallContract(input.runId),
    "",
    "# User Task",
    input.prompt,
    "",
    `# Recent Tool Results\n${JSON.stringify(recentResults)}`,
    "",
    input.feedback.length ? `# Feedback\n${capFeedbackForContext(input.feedback).join("\n\n---\n\n")}` : "# Feedback\nnone",
    "",
    input.negativeConstraints.length
      ? `# Do Not Repeat\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "# Do Not Repeat\nnone",
  ].join("\n\n");
}

function buildEmptyStepToolCalls(step: ExecutionPlanStep, assistantMessage: string, options: { isFinalPlanStep: boolean }): ToolCall[] {
  const evidence = assistantMessage.trim();
  if (!evidence) return [];
  const completionCalls = buildEmptyTaskToolCalls(evidence, { allowImplicit: options.isFinalPlanStep });
  if (completionCalls.length > 0) return completionCalls;
  const normalized = evidence.toLowerCase();
  const indicatesStepDone =
    /\b(step|files?|configuration|setup|implementation|checks?)\s+(is\s+|are\s+|has been\s+|have been\s+)?(complete|completed|done|created|verified|configured|implemented)|\b(proceed|proceeding|continue|continuing|next step)\b|\b(no further|cannot run|unavailable in this environment|manual verification)\b/i.test(
      normalized,
    );
  if (!indicatesStepDone) return [];
  return [
    {
      id: `model-advance-${randomUUID()}`,
      name: "advance_step",
      args: {
        summary: evidence,
        stepId: step.id,
        evidence: [evidence],
      },
    },
  ];
}

function buildEmptyTaskToolCalls(assistantMessage: string, options: { allowImplicit?: boolean } = {}): ToolCall[] {
  const evidence = assistantMessage || "";
  if (!options.allowImplicit && !hasWholeTaskCompletionSignal(evidence)) return [];
  return [
    {
      id: `model-complete-${randomUUID()}`,
      name: "complete_task",
      args: { summary: evidence || "The model reported the requested task is complete and ready for verification." },
    },
  ];
}

function hasWholeTaskCompletionSignal(message: string): boolean {
  return /\b(whole|entire|full|requested)\s+(task|project|app|implementation)\s+(is\s+)?(complete|completed|done|finished)|ready for (final )?verification|all steps (are )?(complete|completed|done)|nothing else (is )?(needed|required)|no further (work|changes) (is )?(needed|required)/i.test(
    message,
  );
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
  delete args.description;
  delete args.reason;
  delete args.explanation;
  if ((typeof name !== "string" || !isKnownToolName(name)) && (typeof args.cmd === "string" || typeof args.command === "string")) {
    name = "run_shell_command";
  }
  if (name === "run_shell_command" && (rawName === "create_directory" || rawName === "mkdir" || rawName === "make_directory")) {
    const directory = typeof args.directory === "string" ? args.directory : typeof args.path === "string" ? args.path : undefined;
    if (directory) {
      args.cmd = `mkdir -p ${shellQuote(directory)}`;
      delete args.directory;
      delete args.path;
    }
  }
  if (name === "run_shell_command" && typeof args.cmd !== "string") {
    for (const key of ["command", "shellCommand", "shell_command"]) {
      if (typeof args[key] === "string") {
        args.cmd = args[key];
        delete args[key];
        break;
      }
    }
  }
  if (name === "run_shell_command" && (rawName === "start_background_process" || rawName === "background_process")) {
    args.isBackground = true;
  }
  if (name === "run_shell_command" && typeof args.cwd !== "string") {
    for (const key of ["working_directory", "workingDirectory", "workdir", "directory"]) {
      if (typeof args[key] === "string") {
        args.cwd = args[key];
        delete args[key];
        break;
      }
    }
  }
  if (name === "run_shell_command" && typeof args.cmd === "string" && typeof args.cwd === "string" && args.cwd.trim()) {
    args.cmd = `cd ${shellQuote(args.cwd.trim())} && ${args.cmd}`;
    delete args.cwd;
  }
  if (name === "run_shell_command" && typeof args.timeoutMs !== "number" && typeof args.timeout === "number") {
    args.timeoutMs = args.timeout;
    delete args.timeout;
  }
  if (["read_background_output", "signal_process", "write_to_process"].includes(String(name)) && typeof args.pid === "number" && args.pid <= 0) {
    args.pid = 1;
  }
  if (name === "run_shell_command" && typeof args.idleTimeoutMs !== "number" && typeof args.idle_timeout_ms === "number") {
    args.idleTimeoutMs = args.idle_timeout_ms;
    delete args.idle_timeout_ms;
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
  if (name === "complete_task") {
    normalizeStringAlias(args, "summary", ["message", "result", "status", "evidence", "note"]);
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
  stripUnknownToolArgs(typeof name === "string" ? name : "", args);
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

function stripUnknownToolArgs(name: string, args: Record<string, unknown>): void {
  const allowedByTool: Record<string, string[]> = {
    read_file: ["path", "startLine", "endLine"],
    view_file: ["path", "startLine", "endLine"],
    list_directory: ["path", "includeHidden"],
    grep_search: ["pattern", "path", "include"],
    skim_file: ["path", "goalHint"],
    inspect_environment: [],
    web_search: ["query", "engine", "maxResults", "scrapePages"],
    write_file: ["path", "content"],
    replace_in_file: ["path", "oldString", "newString", "allowMultiple", "startLine", "endLine", "content"],
    edit_file: ["path", "edits"],
    replace_symbol: ["path", "symbolName", "newCode"],
    delete_file: ["path"],
    run_shell_command: ["cmd", "summary", "barrier", "forceNonBarrier", "isBackground", "timeoutMs", "idleTimeoutMs"],
    read_background_output: ["pid", "lines", "waitForMatch", "minWaitMs"],
    signal_process: ["pid", "signal"],
    write_to_process: ["pid", "input"],
    activate_skill: ["name"],
    get_tool_output: ["artifactId"],
    advance_step: ["summary", "stepId", "evidence"],
    complete_task: ["summary", "verificationContract", "objectives"],
    web_fetch: ["url", "extractText"],
    task_create: ["subject", "description", "status"],
    task_update: ["taskId", "status", "subject", "description"],
    task_list: ["status"],
    call_subagent: ["type", "task", "context", "mode", "allowedFiles", "forbiddenFiles", "timeoutMs", "outputSchema"],
  };
  const allowed = allowedByTool[name];
  if (!allowed) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) {
      delete args[key];
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeToolName(name: string): string {
  const normalized = name.trim();
  const normalizedLower = normalized.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    bash: "run_shell_command",
    shell: "run_shell_command",
    start_background_process: "run_shell_command",
    background_process: "run_shell_command",
    terminal: "run_shell_command",
    run_command: "run_shell_command",
    execute_command: "run_shell_command",
    mkdir: "run_shell_command",
    make_directory: "run_shell_command",
    create_directory: "run_shell_command",
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
    finish: "complete_task",
    complete: "complete_task",
    advance: "advance_step",
    replace_in_file_line_range: "replace_in_file",
    replace_in_file_exact: "replace_in_file",
    edit_file_line_range: "replace_in_file",
    line_range_replace: "replace_in_file",
  };
  return aliases[normalizedLower] ?? aliases[normalized.toLowerCase()] ?? normalized;
}

function isKnownToolName(name: string): boolean {
  return new Set([
    "read_file",
    "list_directory",
    "grep_search",
    "skim_file",
    "inspect_environment",
    "web_search",
    "write_file",
    "replace_in_file",
    "edit_file",
    "replace_symbol",
    "delete_file",
    "run_shell_command",
    "read_background_output",
    "signal_process",
    "write_to_process",
    "activate_skill",
    "get_tool_output",
    "advance_step",
    "complete_task",
    "delegate_to_plan",
    "web_fetch",
    "task_create",
    "task_update",
    "task_list",
  ]).has(name);
}

async function runExplicitVerification(
  input: {
    workspaceRoot: string;
    completionSignal: Extract<ToolCall, { name: "complete_task" }>;
    request: AgentRequestEnvelope;
    trajectoryLogger: TrajectoryLogger;
    auditLogger: AuditLogger;
    toolResults: ToolResult[];
    modelGateway?: ModelGateway | undefined;
    config: ReaperConfig;
  },
): Promise<NonNullable<RuntimeEngineResult["verification"]>> {
  const contractCommands = input.completionSignal.args.verificationContract?.commands;
  const explicitPayload = input.request.payload.verification;
  const explicitCommand =
    explicitPayload && typeof explicitPayload === "object" && typeof (explicitPayload as { command?: unknown }).command === "string"
      ? (explicitPayload as { command: string }).command
      : undefined;
  const normalizedContractCommands = contractCommands?.map((item) => ({
    ...(item.id !== undefined ? { id: item.id } : {}),
    command: item.command,
    ...(item.purpose !== undefined ? { purpose: item.purpose } : {}),
    ...(item.required !== undefined ? { required: item.required } : {}),
  }));
  const command: VerificationCommand | undefined = normalizedContractCommands?.length
    ? { command: normalizedContractCommands.map((item) => item.command).join(" && "), commands: normalizedContractCommands, generated: true }
    : explicitCommand
      ? { command: explicitCommand }
      : undefined;
  const selected = await selectVerificationCommand(input.workspaceRoot, command);
  const requiresExternalCommand = Boolean(normalizedContractCommands?.length || explicitCommand);
  if (!selected) {
    const recentStrict = selectRecentStrictVerificationEvidence(input.toolResults);
    if (!requiresExternalCommand && recentStrict) {
      const groundedSignal = classifyGroundedVerificationSignal(recentStrict.command);
      await writeVerificationGateAudit(input, {
        ok: true,
        signal: groundedSignal,
        message: `Verification gate accepted recent command-backed evidence: ${recentStrict.command}`,
      });
      return {
        ok: true,
        attemptCount: 0,
        retryBudgetConsumed: 0,
        command: recentStrict.command,
        groundedSignal,
        feedback: [`Accepted recent command-backed strict verification evidence: ${recentStrict.command}`],
        negativeConstraints: [],
      };
    }
    await writeVerificationGateAudit(input, {
      ok: false,
      signal: { kind: "none", command: "", grounded: false },
      message: "Verification gate found no runnable grounded verification command.",
    });
    return {
      ok: false,
      attemptCount: 0,
      retryBudgetConsumed: 0,
      failureClasses: ["no_verification_command"],
      feedback: [
        "No runnable verification command was found. This is not a successful completion signal. Add a real task-local verification script/command plus at least one matching test/smoke file that the command will discover, install any required test runner in that package, and rerun verification.",
      ],
      negativeConstraints: [
        "Do not treat missing verification as success.",
        "Do not leave package scripts as placeholders such as 'no test specified'.",
        "Do not create only a test script without a matching test file under __tests__, test, tests, or a *.test/*.spec path.",
        "Do not create nested duplicate package roots to escape a bad package.json; repair the intended task-local package manifest.",
      ],
    };
  }
  if (input.config.verification.enforceFailBeforeFixForGeneratedChecks) {
    const invariant = validateGeneratedVerificationInvariant({
      verification: selected,
      priorResults: input.toolResults,
    });
    if (!invariant.ok) {
      const signal = classifyGroundedVerificationSignal(invariant.missingCommands[0] ?? selected.command);
      await writeVerificationGateAudit(input, {
        ok: false,
        signal,
        message: invariant.message,
        details: { missingCommands: invariant.missingCommands },
      });
      return {
        ok: false,
        attemptCount: 0,
        retryBudgetConsumed: 0,
        command: selected.command,
        groundedSignal: signal,
        failureClasses: ["generated_check_no_fail_before"],
        feedback: [invariant.message, ...invariant.missingCommands.map((item) => `Rejected generated check that already passed before final verification: ${item}`)],
        negativeConstraints: [
          "Do not use a generated reproduction check as final proof when the exact check already passed before the repair.",
          "Prefer fail-before/pass-after reproduction evidence for generated checks, and always keep the failing result in the trace when available.",
        ],
      };
    }
  }
  const maxIterations = getVerificationMaxIterations(explicitPayload);
  const feedback: string[] = [];
  const negativeConstraints: string[] = [];
  const recentFailureKinds: VerificationFailureKind[] = [];
  let attemptCount = 0;
  let retryBudgetConsumed = 0;
  let lastCommand = selected.command;

  while (retryBudgetConsumed < maxIterations) {
    attemptCount += 1;
    const result = await runVerificationCommand(input.workspaceRoot, selected);
    lastCommand = result.command;
    const summary = createVerificationSummary(result, attemptCount);
    await input.trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: input.request.trace_id,
      session_id: input.request.session_id,
      trace_id: input.request.trace_id,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "verification_summary",
      level: "info",
      attempt_count: summary.attemptCount,
      pass_fail: summary.passFail,
      lite_verified: summary.liteVerified,
    });

    if (result.ok && (await isInsufficientVerificationForRequest(input.workspaceRoot, input.request, selected))) {
      const message =
        `Verification command '${lastCommand}' passed but is insufficient for this complex application task. ` +
        "The selected check does not prove requested workflows. Add or run a real behavioral test/runtime smoke check that exercises the implemented behavior, including the requested auth/login/register and task create/update/delete/filter flows when those are part of the prompt.";
      feedback.push(message);
      negativeConstraints.push("Do not treat build-only or trivial health-only verification as enough for complex full-stack application tasks.");
      negativeConstraints.push("Do not rerun the same health-only test as final verification. Update or add tests that exercise requested workflows such as auth/login/register and task create/update/delete/filter when present.");
      retryBudgetConsumed += 1;
      continue;
    }

    if (result.ok) {
      if (input.config.verification.requireGroundedCompletion && !result.groundedSignal.grounded) {
        const message =
          `Verification command '${lastCommand}' passed but did not provide a grounded external signal. ` +
          "Completion requires a real test exit code, build, type-check, lint, or executed reproduction/artifact check.";
        feedback.push(message);
        negativeConstraints.push("Do not treat LLM judgment, printed observations, or self-report as final verification.");
        await writeVerificationGateAudit(input, {
          ok: false,
          signal: result.groundedSignal,
          message,
        });
        return {
          ok: false,
          attemptCount,
          retryBudgetConsumed,
          command: lastCommand,
          groundedSignal: result.groundedSignal,
          failureClasses: ["no_grounded_verification_signal"],
          feedback,
          negativeConstraints,
        };
	      }
	      let selfDebugExplanation: string | undefined;
	      if (input.config.verification.selfDebugExplanation.enabled && input.modelGateway) {
        const selfDebug = await runSelfDebugExplanation({
          modelGateway: input.modelGateway,
          role: input.config.modelRouting.judge,
          prompt: typeof input.request.payload.prompt === "string" ? input.request.payload.prompt : "",
          completionSummary: input.completionSignal.args.summary,
          verificationCommand: lastCommand,
          verificationOutput: result.output,
        });
        selfDebugExplanation = selfDebug.explanation;
        if (!selfDebug.ok) {
          const message = `Self-debug explanation found completion discrepancies: ${selfDebug.discrepancies.join("; ")}`;
          await writeVerificationGateAudit(input, {
            ok: false,
            signal: result.groundedSignal,
            message,
            details: { discrepancies: selfDebug.discrepancies, explanation: selfDebug.explanation },
          });
          return {
            ok: false,
            attemptCount,
            retryBudgetConsumed,
            command: lastCommand,
            groundedSignal: result.groundedSignal,
            ...(selfDebugExplanation ? { selfDebugExplanation } : {}),
            failureClasses: ["self_debug_discrepancy"],
            feedback: [...feedback, message],
            negativeConstraints: [...negativeConstraints, "Resolve the discrepancies identified by the self-debug review before completing."],
	          };
	        }
	      }
	      let diffReviewExplanation: string | undefined;
	      if (input.config.verification.freshContextDiffReview.enabled && input.modelGateway) {
	        const diff = await collectWorkspaceDiff(input.workspaceRoot, input.config.verification.freshContextDiffReview.maxDiffChars);
	        const diffReview = await runFreshContextDiffReview({
	          modelGateway: input.modelGateway,
	          role: input.config.modelRouting.judge,
	          prompt: typeof input.request.payload.prompt === "string" ? input.request.payload.prompt : "",
	          completionSummary: input.completionSignal.args.summary,
	          verificationCommand: lastCommand,
	          verificationOutput: result.output,
	          diff,
	        });
	        diffReviewExplanation = diffReview.explanation;
	        if (!diffReview.ok) {
	          const message = `Fresh-context diff review found completion discrepancies: ${diffReview.discrepancies.join("; ")}`;
	          await writeVerificationGateAudit(input, {
	            ok: false,
	            signal: result.groundedSignal,
	            message,
	            details: { discrepancies: diffReview.discrepancies, explanation: diffReview.explanation },
	          });
	          return {
	            ok: false,
	            attemptCount,
	            retryBudgetConsumed,
	            command: lastCommand,
	            groundedSignal: result.groundedSignal,
	            ...(selfDebugExplanation ? { selfDebugExplanation } : {}),
	            ...(diffReviewExplanation ? { diffReviewExplanation } : {}),
	            failureClasses: ["fresh_context_diff_review"],
	            feedback: [...feedback, message],
	            negativeConstraints: [...negativeConstraints, "Resolve the discrepancies identified by fresh-context diff review before completing."],
	          };
	        }
	      }
	      await writeVerificationGateAudit(input, {
	        ok: true,
	        signal: result.groundedSignal,
	        message: `Verification gate accepted grounded ${result.groundedSignal.kind} signal: ${result.groundedSignal.command}`,
	        ...(selfDebugExplanation || diffReviewExplanation ? { details: { ...(selfDebugExplanation ? { selfDebugExplanation } : {}), ...(diffReviewExplanation ? { diffReviewExplanation } : {}) } } : {}),
	      });
	      return {
	        ok: true,
	        attemptCount,
	        retryBudgetConsumed,
	        command: lastCommand,
	        groundedSignal: result.groundedSignal,
	        ...(selfDebugExplanation ? { selfDebugExplanation } : {}),
	        ...(diffReviewExplanation ? { diffReviewExplanation } : {}),
	        feedback,
	        negativeConstraints,
	      };
    }

    feedback.push(result.output);
    if (/No tests found|0 matches|no test files|No test files found/i.test(result.output)) {
      negativeConstraints.push("A test runner with zero discovered tests is not verification. Create at least one meaningful test file matching the runner discovery pattern before rerunning.");
    }
    const kind = classifyVerificationFailure(result.output);
    recentFailureKinds.push(kind);
    if (kind === "deterministic" || shouldPromoteNonDeterministicFailure(recentFailureKinds)) {
      retryBudgetConsumed += 1;
    }
  }

  const classified = classifyVerificationOutput(feedback.join("\n"));
  await writeVerificationGateAudit(input, {
    ok: false,
    signal: classifyGroundedVerificationSignal(lastCommand),
    message: "Verification gate rejected completion because the grounded command failed.",
  });
  return {
    ok: false,
    attemptCount,
    retryBudgetConsumed,
    command: lastCommand,
    groundedSignal: classifyGroundedVerificationSignal(lastCommand),
    failureClasses: uniqueStrings(["verification_fail", ...classified.classes]),
    feedback: [...feedback, ...classified.facts.slice(0, 6), classified.repairStrategy],
    negativeConstraints,
  };
}

async function writeVerificationGateAudit(
  input: {
    request: AgentRequestEnvelope;
    auditLogger: AuditLogger;
  },
  event: {
    ok: boolean;
    signal: VerificationGroundedSignal;
    message: string;
    details?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await input.auditLogger.write({
    event_id: randomUUID(),
    run_id: input.request.trace_id,
    session_id: input.request.session_id,
    trace_id: input.request.trace_id,
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "verification_gate",
    severity: event.ok ? "warn" : "error",
    message: event.message,
    signal: event.signal.kind,
    details: {
      ok: event.ok,
      command: event.signal.command,
      grounded: event.signal.grounded,
      ...(event.details ?? {}),
    },
  });
}

function getVerificationMaxIterations(input: unknown): number {
  return 1;
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
    (result) => result.name === "run_shell_command" && result.ok && result.output && typeof result.output === "object" && "pid" in result.output,
  );
  const foregroundCheckSucceeded = currentResults.some((result) => {
    if (result.name !== "run_shell_command" || !result.ok) return false;
    const cmd = typeof (result.args as { cmd?: unknown }).cmd === "string" ? (result.args as { cmd: string }).cmd : "";
    if (!/\b(curl|wget|test|spec|pytest|jest|vitest|mocha|node\s+--test|go\s+test|cargo\s+test|check|smoke)\b/i.test(cmd)) return false;
    return !(result.output && typeof result.output === "object" && "pid" in result.output);
  });
  return startedBackground && foregroundCheckSucceeded;
}

function hasRecentVerificationOrRuntimeFailure(toolResults: ToolResult[]): boolean {
  const latest = toolResults.at(-1);
  if (!latest) return false;
  if (isSemanticFailedCheckResult(latest)) return true;
  if (latest.ok) return false;
  const message = latest.error?.message ?? "";
  return /\b(test|spec|build|compile|lint|server|runtime|verification|cannot find module|timeout|open handle|ECONNREFUSED)\b/i.test(message);
}

function getBoundaryPivotInstruction(toolResults: ToolResult[]): { feedback: string; negativeConstraint: string } | undefined {
  const recent = toolResults.slice(-80);
  const overpatchedBlocks = recent.filter((result) => !result.ok && result.error?.code === "overpatched_source_file_blocked");
  if (overpatchedBlocks.length < 2) return undefined;
  const compileFailures = recent.filter((result) => {
    if (result.ok || result.name !== "run_shell_command") return false;
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

function isControlFlowBlockingFailure(result: ToolResult): boolean {
  const code = result.error?.code ?? "";
  const message = result.error?.message ?? "";
  return (
    code === "advance_step_blocked" ||
    code === "repeated_read_only_batch_blocked" ||
    code === "implementation_read_only_drift_blocked" ||
    code === "relevance_gate_blocked" ||
    /blocked repeated read-only batch|blocked this action as irrelevant|rejected advance_step/i.test(message)
  );
}

function findLatestUnresolvedControlFlowBlockingFailure(results: ToolResult[]): ToolResult | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result || result.ok || !isControlFlowBlockingFailure(result)) continue;
    if (hasLaterProgressEvidenceForFailure(result, results.slice(index + 1))) continue;
    return result;
  }
  return undefined;
}

function hasLaterProgressEvidenceForFailure(failure: ToolResult, laterResults: ToolResult[]): boolean {
  if (laterResults.some((result) => result.ok && result.name === "advance_step")) return true;
  const failureArgs = failure.args && typeof failure.args === "object" ? (failure.args as Record<string, unknown>) : {};
  const failurePath = typeof failureArgs.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(failureArgs.path)) : "";
  return laterResults.some((result) => {
    if (!result.ok) return false;
    if (result.name === "run_shell_command" && isProducerOrVerificationCommand(getToolResultCommand(result))) return true;
    if (!failurePath || !["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "read_file"].includes(result.name)) return false;
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    const pathArg = typeof args.path === "string" ? normalizeArtifactPathForMatch(stripWorkspacePrefix(args.path)) : "";
    return pathArg === failurePath;
  });
}

function shouldRepairBeforeReplan(state: GraphState): boolean {
  const planLength = state.executionPlan?.length ?? 0;
  const planRemaining = planLength > 0 && state.currentStepIndex < planLength;
  if (!planRemaining && !state.lastBatchFailed) return false;
  if (state.patchingStepIndex !== null) {
    const stepId = state.executionPlan?.[state.patchingStepIndex]?.id;
    const attempts = stepId ? state.patchAttemptsByStep[stepId] ?? 0 : 0;
    return attempts < getMaxPatchAttemptsPerStep() && state.patcherInvocationCount < getMaxPatchAttemptsPerRun();
  }
  if (hasRecentVerificationOrRuntimeFailure(state.toolResults)) return true;
  if (getPendingStaleWriteReadRepair(state.toolResults) || getPendingFailedExactEditReadRepair(state.toolResults) || getPendingSafeEditRegionRepair(state.toolResults)) {
    return true;
  }
  const facts = deriveRuntimeBlockingFacts(state.toolResults);
  if (facts.failedBuildOrCompile.length > 0 || facts.failedRuntimeOrVerification.length > 0 || facts.missingArtifacts.length > 0) {
    return true;
  }
  return false;
}

async function isInsufficientVerificationForRequest(workspaceRoot: string, request: AgentRequestEnvelope, verification: VerificationCommand): Promise<boolean> {
  const prompt = typeof request.payload.prompt === "string" ? request.payload.prompt : "";
  if (!/\b(full[- ]stack|complete|e-?commerce|chat|kanban|collaborative|platform|web application|frontend|backend|authentication|database)\b/i.test(prompt)) {
    return false;
  }
  const commands = verification.commands?.filter((item) => item.required !== false).map((item) => item.command) ?? [verification.command];
  const joined = commands.join(" && ");
  const hasBehavioralCheck = /\b(test|spec|pytest|jest|vitest|mocha|node\s+--test|go\s+test|cargo\s+test|curl|playwright|cypress|smoke)\b/i.test(joined);
  const buildOnly = /\b(build|tsc|compile|lint)\b/i.test(joined) && !hasBehavioralCheck;
  if (buildOnly || !hasBehavioralCheck) return true;
  if (!(await hasSourceCoverageForPrompt(workspaceRoot, prompt))) return true;
  return !(await hasBehavioralCoverageForPrompt(workspaceRoot, prompt));
}

async function hasSourceCoverageForPrompt(workspaceRoot: string, prompt: string): Promise<boolean> {
  const files = await collectSourceFiles(workspaceRoot);
  if (files.length === 0) return false;
  const joined = (
    await Promise.all(
      files.slice(0, 80).map(async (file) => {
        try {
          return await import("node:fs/promises").then((fs) => fs.readFile(path.join(workspaceRoot, file), "utf8"));
        } catch {
          return "";
        }
      }),
    )
  )
    .join("\n")
    .toLowerCase();
  if (!joined.trim()) return false;
  const requiredGroups: string[][] = [];
  if (/\bauth(?:entication|orization)?|login|register|jwt|session\b/i.test(prompt)) {
    requiredGroups.push(["/auth", "login", "register", "jwt", "password", "authorization", "bearer"]);
  }
  if (/\bcrud|create|edit|update|delete|task|todo\b/i.test(prompt)) {
    requiredGroups.push(["task", "todo", "create", "post", "put", "patch", "delete", "filter"]);
  }
  if (/\bfilter|search|sort|status\b/i.test(prompt)) {
    requiredGroups.push(["filter", "search", "sort", "status", "query"]);
  }
  if (/\bfrontend|ui|responsive|react|vue|svelte|page\b/i.test(prompt)) {
    requiredGroups.push(["component", "form", "fetch", "axios", "useeffect", "onclick", "className", "responsive"]);
  }
  if (/\bdatabase|persistent|persistence|postgres|mongo|sqlite|storage\b/i.test(prompt)) {
    requiredGroups.push(["mongoose", "schema", "model", "sequelize", "prisma", "sqlite", "postgres", "database"]);
  }
  if (requiredGroups.length === 0) return true;
  const covered = requiredGroups.filter((group) => group.some((term) => joined.includes(term))).length;
  return covered >= Math.max(1, Math.ceil(requiredGroups.length * 0.7));
}

async function hasBehavioralCoverageForPrompt(workspaceRoot: string, prompt: string): Promise<boolean> {
  const files = await collectBehavioralCheckFiles(workspaceRoot);
  if (files.length === 0) return false;
  const joined = (
    await Promise.all(
      files.slice(0, 20).map(async (file) => {
        try {
          return await import("node:fs/promises").then((fs) => fs.readFile(path.join(workspaceRoot, file), "utf8"));
        } catch {
          return "";
        }
      }),
    )
  )
    .join("\n")
    .toLowerCase();
  if (!joined.trim()) return false;
  const requestedGroups: string[][] = [];
  if (/\bauth(?:entication|orization)?|login|register|jwt|session\b/i.test(prompt)) requestedGroups.push(["auth", "login", "register", "jwt", "session", "user"]);
  if (/\bcrud|create|edit|update|delete|task|todo\b/i.test(prompt)) requestedGroups.push(["task", "todo", "create", "edit", "update", "delete", "complete"]);
  if (/\bfilter|search|sort|status\b/i.test(prompt)) requestedGroups.push(["filter", "search", "sort", "status"]);
  if (/\bfrontend|ui|responsive|react|vue|svelte|page\b/i.test(prompt)) requestedGroups.push(["render", "screen", "page", "click", "form", "component", "responsive"]);
  if (requestedGroups.length === 0) return !/\bhealth\b/.test(joined);
  const covered = requestedGroups.filter((group) => group.some((term) => joined.includes(term))).length;
  const healthOnly = /\bhealth\b/.test(joined) && covered === 0;
  return !healthOnly && covered >= Math.min(2, requestedGroups.length);
}

async function collectBehavioralCheckFiles(root: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth < 0 || out.length >= 80) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build" || entry.name === "coverage") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel, depth - 1);
      } else if (/(^|\/)(__tests__|tests?|specs?|e2e|smoke)(\/|$)|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py)$/i.test(rel)) {
        out.push(rel);
      }
    }
  }
  await walk("", 5);
  return out;
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth < 0 || out.length >= 160) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build" || entry.name === "coverage") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel, depth - 1);
      } else if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|php|rb)$|(?:^|\/)(Dockerfile|docker-compose\.ya?ml|package\.json)$/i.test(rel)) {
        out.push(rel);
      }
    }
  }
  await walk("", 6);
  return out;
}

function getGraphRecursionLimit(): number {
  const raw = process.env.REAPER_LANGGRAPH_RECURSION_LIMIT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 100) {
    return parsed;
  }
  return 8000;
}

function getMaxPatchAttemptsPerStep(): number {
  const raw = process.env.REAPER_MAX_PATCH_ATTEMPTS_PER_STEP;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return 5;
}

function getMaxPatchAttemptsPerRun(): number {
  const raw = process.env.REAPER_MAX_PATCH_ATTEMPTS_PER_RUN;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return 24;
}

function getMaxRescueAttemptsPerDiagnostic(): number {
  const raw = process.env.REAPER_RESCUE_MAX_ATTEMPTS_PER_DIAGNOSTIC;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return 6;
}

function getMaxRescueStagnantTurns(): number {
  const raw = process.env.REAPER_RESCUE_MAX_STAGNANT_TURNS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return 4;
}


export async function resolvePlannerMaxTokensForProfile(
  input: { modelGateway: { resolveRole: (role: ModelRole) => Promise<ResolvedModelProfile> | ResolvedModelProfile } },
): Promise<number> {
  try {
    const resolved = await Promise.resolve(input.modelGateway.resolveRole("planner"));
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
function finalStageCompletionGateIteration(): number {
  const raw = process.env.REAPER_FINAL_STAGE_COMPLETION_GATE_ITERATION;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 20) {
    return parsed;
  }
  return 120;
}
