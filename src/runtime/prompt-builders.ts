/**
 * Phase T3.11 Wave 2a — planner + patcher subagent prompt builders.
 *
 * Pure prompt-rendering functions extracted from engine.ts. Each
 * entrypoint builds the system + user prompts for one of Reaper's
 * subagent calls (planner / patcher). The leaf helpers handle the
 * parse, context selection, and chunk-budget math.
 *
 * Extracted from engine.ts (Wave 2a). Behavior must be identical.
 * All call sites in engine.ts switch to imports from this module.
 *
 * Cross-dependency helpers (still in engine.ts) are imported from
 * "./engine.js". Already-extracted helpers come from "./file-hints.js",
 * "./relevance-gate.js", "./rescue-watchdog.js", and other runtime
 * modules.
 */

import type { ContentPrepResult } from "../runtime/content-prep.js";
import type {
  ExecutionPlanStep,
  PlannerStepType,
  PlannerSubagentPlan,
  PatcherSubagentResult,
} from "./engine.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { persistExecutionPlanProgress } from "./relevance-gate.js";

import { renderToolResultForModel } from "../context/history-compaction.js";
import {
  extractFilePathsFromFailure,
  inferFilesHintFromResults,
  isGeneratedOrBuildPath,
  uniqueStrings,
} from "./file-hints.js";
import { renderFingerprintForPrompt } from "./fingerprint.js";
import {
  buildRescueHypothesisLedger,
  renderRescueHypothesisLedger,
} from "./hypothesis-ledger.js";
import { isVerificationLikeCommand } from "./relevance-gate.js";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

import {
  classifyDiagnosticCommand,
  collectRecentlyTouchedFiles,
  computeEditLocalityScore,
  computeWastedTrajectoryRatio,
  getRepeatedCommandLedger,
  getRepeatedDiagnosticFailure,
  getSemanticFailureSignal,
  getToolResultText,
  hasInformativeToolResultOutput,
  inferAllowedDirs,
  isBuildArtifactRuntimeCommand,
  isCompileOrBuildError,
  isExplicitBuildTestOrCheckCommand,
  isLowInformationShellCommand,
  isLowInformationToolResult,
  isPatchWorthyDiagnosticFailure,
  isProducerOrVerificationCommand,
  isReadOnlyToolResult,
  isStrictArtifactCheckCommand,
  isSuccessfulStrictVerificationResult,
  isTaskAcceptanceCommand,
  parseToolCallArray,
  renderAgentSourceReliabilityPatterns,
  renderOptimizationFrame,
  renderPlanStepCoverageText,
  renderToolCallContract,
  renderToolResultSnippet,
  requiresExplicitOutputProducer,
  selectRecentStrictVerificationEvidence,
  stableHash,
  summarizeCommandStream,
} from "./engine.js";

export function ensureEndToEndPlannerSteps(input: {
  prompt: string;
  steps: ExecutionPlanStep[];
  toolResults: ToolResult[];
  feedback: string[];
}): ExecutionPlanStep[] {
  if (input.steps.length === 0) return input.steps;
  const base = input.steps[0];
  if (!base) return input.steps;
  const prompt = input.prompt.toLowerCase();
  const inspectionOnly = input.steps.every((step) => (step.type ?? "inspect") === "inspect" || /inspect|diagnos|analy[sz]e|review/i.test(step.title));
  const userOnlyAskedForInspection = /\b(?:inspect|analy[sz]e|review|explain|diagnose)\b/.test(prompt) && !/\b(?:build|create|implement|fix|convert|generate|write|test|complete|solve|run)\b/.test(prompt);
  let steps = input.steps;
  if (inspectionOnly && !userOnlyAskedForInspection) {
    steps = [
    base,
    {
      id: "implement-visible-contract",
      title: "Implement or generate the required deliverables",
      type: "command",
      instructions:
        "Use the inspection evidence, visible specs, tests, validation scripts, and expected output formats to implement the smallest working solution or generate the required deliverables. Prefer boundary adapters, wrappers, small standalone tools, or artifact generation when legacy/vendor internals are brittle.",
      suggestedImplementation:
        "Read only the specific spec/test files needed, then create or edit the task-facing files. Do not keep repairing internals that are not required by the visible acceptance contract.",
      testGuidance: "Run a narrow command that exercises the created deliverable or tool.",
      successCriteria: ["The requested externally visible files/tool/API/output exists.", "The implementation is not blocked on unrelated internal rewrites."],
      onFailure: "needs_replan",
      agent: "executor",
      tool_calls: [],
    },
    {
      id: "verify-visible-contract",
      title: "Verify the required deliverables",
      type: "test",
      instructions:
        "Run the task-local validation, tests, build, producer, smoke check, or equivalent visible acceptance check. If a generated artifact is required, verify that the artifact exists and matches the documented shape/content.",
      suggestedImplementation:
        "Prefer provided tests or validation scripts. If no test exists, write or run a narrow check based on the visible specification. Avoid placeholder success commands.",
      testGuidance: "Use the real task validation command or a narrow equivalent derived from visible specs/tests.",
      successCriteria: ["A real validation/build/test/runtime check passes.", "Failures are concrete enough to repair without restarting the task."],
      onFailure: "request_patch",
      agent: "executor",
      tool_calls: [],
    },
    {
      id: "finalize-task",
      title: "Finalize with model-written completion summary",
      type: "finalize",
      instructions: "Before emitting complete_task, verify the deliverable end-to-end: (a) hunt for a workspace-provided oracle — directories or files named like `tests/`, `test/`, `spec/`, `expected*`, `reference*`, `examples/`, `golden/`, `fixtures/`, `solution*`, `run-tests.*`, `Makefile`/`justfile`/`package.json scripts`/`pytest.ini`/`tox.ini`/`cargo test`/etc. — and if any are present and readable, run them verbatim or read them as the source of truth for shape and format, (b) observe the deliverable by reading/running it the way the spec describes, (c) cross-check both content (values, counts, structure) and form (exact whitespace, punctuation, casing, line breaks shown in any spec example) — any literal output template or code block in the spec is byte-exact unless an `{PLACEHOLDER}` or `<like_this>` marker indicates substitution, (d) compare scale/shape against the input — wildly off magnitudes are parsing bugs, not success. Only then emit complete_task. If any cross-check is off, treat it as a bug and continue with concrete tool use.",
      suggestedImplementation: "Summarize files changed and checks run only after successful validation.",
      testGuidance: "Do not finalize unless the latest meaningful check passed or testing is explicitly unavailable with evidence.",
      successCriteria: ["complete_task is emitted only after the requested task is complete."],
      onFailure: "needs_replan",
      agent: "executor",
      tool_calls: [],
    },
    ];
  }
  return ensureExplicitDeliverableCoverage(input.prompt, steps);
}



export function ensureExplicitDeliverableCoverage(prompt: string, steps: ExecutionPlanStep[]): ExecutionPlanStep[] {
  const promptText = prompt.toLowerCase();
  const planText = steps.map(renderPlanStepCoverageText).join("\n").toLowerCase();
  const next = [...steps];

  if (requiresExplicitOutputProducer(promptText) && !requiresExplicitOutputProducer(planText)) {
    next.push({
      id: "implement-required-output-producer",
      title: "Implement required output producer",
      type: "command",
      instructions:
        "Implement the task-facing producer required by the prompt. Inspect the visible format/spec/tests, create the required tool, script, endpoint, or workflow, and generate outputs in the requested location. Keep the implementation acceptance-first and avoid unrelated internal rewrites.",
      suggestedImplementation:
        "Use the active language/toolchain or a small standalone tool when that best satisfies the visible contract. Generate the documented output files and preserve required filenames/paths.",
      testGuidance: "Run the producer on the provided sample/input files and check that the expected output files exist.",
      successCriteria: ["The required producer exists.", "Required output files are produced in the requested path.", "Outputs follow the visible format/spec."],
      onFailure: "request_patch",
      agent: "executor",
      tool_calls: [],
    });
  }

  if (/\b(all|every|each)\b.*\b(file|item|record|input|sample|case)s?\b|\b(?:process|produce|generate|transform|convert)\s+all\b/.test(promptText) && !/\b(all|every|each)\b.*\b(file|item|record|input|sample|case)s?\b|\b(?:process|produce|generate|transform|convert)\s+all\b/.test(planText)) {
    next.push({
      id: "process-all-required-inputs",
      title: "Process every required input",
      type: "command",
      instructions:
        "Run the implemented tool/workflow across every input file/case required by the prompt, not just one sample. Verify the output count and filenames match the input set or documented contract.",
      suggestedImplementation: "List the relevant input set, run the producer for each input, then list the outputs and compare counts/names.",
      testGuidance: "Use a narrow check command to compare expected and actual outputs.",
      successCriteria: ["Every required input is processed.", "Output names/counts match the prompt or visible tests."],
      onFailure: "request_patch",
      agent: "executor",
      tool_calls: [],
    });
  }

  if (/\b(test|verify|validate|ensure|pass)\b|json format|output/.test(promptText) && !/\b(test|verify|validate|smoke|check|final)\b/.test(planText)) {
    next.push({
      id: "validate-visible-acceptance-contract",
      title: "Validate the visible acceptance contract",
      type: "verify",
      instructions:
        "Run the real task-local validation/build/test/runtime check, or derive the narrowest non-placeholder check from visible specs/tests. Do not finalize based on file existence alone when schema/content is specified.",
      suggestedImplementation: "Prefer provided tests or validation scripts; otherwise run a narrow parser/schema/content check based on the documented format.",
      testGuidance: "The latest meaningful check must pass before complete_task.",
      successCriteria: ["A real validation/check passes.", "Any failures have concrete diagnostics for repair."],
      onFailure: "request_patch",
      agent: "executor",
      tool_calls: [],
    });
  }

  if (!/\bfinal|complete_task|completion summary\b/.test(planText)) {
    next.push({
      id: "finalize-task",
      title: "Finalize with completion signal",
      type: "finalize",
      instructions: "When all explicit prompt deliverables and checks are complete, emit complete_task with a concise model-written summary. Do not emit the summary before the final successful check. Before signaling completion: (1) if the workspace ships a verifier — `tests/`, `test/`, `run-tests.*`, `Makefile` target, `pytest`/`npm test`/`cargo test`/`go test`/equivalent — run it verbatim and observe the pass result; treat its output as the authoritative oracle, (2) exercise the deliverable the way the spec describes it being used, (3) cross-check against the spec on both content (values, counts, structure) and form — any literal output template, code block, or example in the spec is byte-exact unless a `{PLACEHOLDER}` / `<like_this>` marker indicates substitution; whitespace, indentation, casing, punctuation, line breaks all count, (4) sanity-check scale against the input (wildly off magnitudes mean a parsing bug). 'It exists' or 'it ran' is not evidence of correctness.",
      suggestedImplementation: "Summarize changed files, produced artifacts, and checks run.",
      testGuidance: "Only finalize after the task-facing acceptance evidence exists.",
      successCriteria: ["complete_task is emitted only after the full requested task is complete."],
      onFailure: "needs_replan",
      agent: "executor",
      tool_calls: [],
    });
  }

  return next.slice(0, 20);
}



export function buildPlannerSubagentPrompt(input: {
  prompt: string;
  contentPrep: ContentPrepResult;
  toolResults: ToolResult[];
  iteration: number;
  feedback: string[];
  negativeConstraints: string[];
}): string {
  const recentResults = selectPlannerToolResults(input.toolResults).map((result) => renderToolResultForModel(result));
  const compactedHistory = input.contentPrep.compactedHistory.compacted.slice(-3).join("\n");
  const boundedFeedback = input.feedback
    .map((entry) => entry.length > 1500 ? `${entry.slice(0, 1500)}\n...[truncated for planner prompt budget]` : entry)
    .slice(-2);
  const context = selectPlannerContextChunks(input.contentPrep)
    .map((chunk) => `FILE: ${chunk.path}\n${chunk.content.slice(0, plannerChunkBudget(chunk.path))}`)
    .join("\n\n---\n\n");
  const fileTree = compactPlannerFileTree(input.contentPrep.preparedContext.fileTree).join("\n");
  const environment = renderFingerprintForPrompt(input.contentPrep.environmentFingerprint);

  return [
    "# Planner Subagent Tool",
    "You are a fixed-workflow planner subagent. You do not execute code and you do not talk to the user.",
    "Your only output is the schema requested by the parent Reaper graph.",
    "Your purpose is to reduce future agent confusion through orchestration and decomposition.",
    "",
    "# Role Boundaries",
    "You are NOT responsible for writing large amounts of code.",
    "You are responsible for understanding the user's goal, analyzing current repository/task state, breaking work into small executable tasks, maintaining progress awareness, adapting after failures, and keeping execution context focused.",
    "",
    "# Fixed Internal Workflow",
    "1. Understand the goal deeply before planning.",
    "2. Identify affected systems/components.",
    "3. Estimate complexity and dependencies.",
    "4. Produce ordered small executable tasks.",
    "5. For each task, include a narrow objective, exact action type, likely files, concrete commands when applicable, implementation suggestions, success criteria, advancement evidence, and test guidance.",
    "6. Incorporate execution results, failures, reviewer feedback, test failures, repository discoveries, and negative constraints.",
    "7. Return only the parent-requested schema. No markdown, no prose outside JSON.",
    "",
    "# Output Schema",
    "Return ONLY JSON with shape:",
    "{\"installs\":[{\"manager\":\"npm|pnpm|yarn|pip|cargo|go|system|none\",\"packages\":[\"pkg\"],\"reason\":\"why\"}],\"steps\":[{\"id\":\"stable-id\",\"title\":\"short title\",\"type\":\"inspect|command|test|verify|review|finalize\",\"instructions\":\"explicit current-step objective and boundaries\",\"suggestedImplementation\":\"concrete executor guidance, including what to create/edit/run and what not to touch\",\"testGuidance\":\"how to validate this step\",\"successCriteria\":[\"observable criterion\"],\"onFailure\":\"request_patch|needs_replan|abort\",\"tool_calls\":[]}],\"testGuidance\":\"model-managed testing guidance\"}",
    "Planner steps must set tool_calls to []. The executor model generates concrete non-patching tool calls for each step and decides step advancement or patch request.",
    "Keep suggestedImplementation and testGuidance short: one or two sentences each (under 600 and 400 characters respectively). The runtime will truncate longer fields. Success criteria entries must each be under 300 characters and you may include up to 6.",
    "",
    "# Predefined Step Types",
    "You MUST label each step with exactly one of these predefined types based on what the step DOES:",
    "- inspect: read-only discovery only. Allowed actions: list/read/search/inspect existing files, specs, inputs, logs, APIs, config. No edits, no builds required as success.",
    "- command: implementation or operational work. Use when the step creates/edits files, installs needed dependencies/tools, scaffolds config, builds/compiles, runs a producer/converter/script, starts/stops services, or performs any non-test shell workflow.",
    "- test: run automated tests or a narrow test command. Use for unit/integration/e2e test execution and test-specific repair evidence.",
    "- verify: acceptance validation. Use for schema/output/content/runtime smoke checks, comparing expected vs actual artifacts, final build+run validation, or official/user-facing verification.",
    "- review: inspect/review produced changes after implementation. Use for diff review, sanity review, or risk review without primary mutation.",
    "- finalize: final completion signal only. Use only when all deliverables/checks are complete and the executor should emit complete_task.",
    "Type selection rules:",
    "- If a step says fix, patch, port, repair, migrate, implement, create, write, edit, replace, generate, convert, produce, build, compile, run, install, start, or stop, type MUST be command unless it is specifically an automated test or acceptance verification.",
    "- If a step runs pytest/jest/vitest/go test/cargo test/mvn test/gradle test or similar, type MUST be test.",
    "- If a step checks outputs against a spec, validates JSON/schema/content, compares artifact counts, or confirms final acceptance, type MUST be verify.",
    "- If a step is only reading/listing/searching and its success is knowledge gathering, type MUST be inspect.",
    "- A step that says 'fix all platform issues' or 'port code' is NOT inspect. It is command and must include build/check advancement evidence.",
    "- A step that creates a converter and runs it is command. A later step that validates converter outputs against JSON_FORMAT.md is verify.",
    "Every non-final step must include non-empty successCriteria. The executor decides what evidence justifies advance_step from successCriteria plus the live tool results.",
    "Use onFailure:\"request_patch\" when a step may reveal a bug, failing test, compatibility issue, regression, or medium/large fix requiring focused patch-and-test handling.",
    "Normal feature implementation and planned file creation/editing may be executed by the executor. The patcher is for bug/repair work, not every edit.",
    "",
    "# Planning Rules",
    renderOptimizationFrame({
      prompt: input.prompt,
      toolResults: input.toolResults,
      feedback: input.feedback,
      negativeConstraints: input.negativeConstraints,
      mode: "planner",
    }),
    "",
    renderAgentSourceReliabilityPatterns("planner"),
    "",
    "Small tasks are better than large tasks. Explicit tasks are better than vague tasks.",
    "Incremental and reversible changes are better than sweeping rewrites.",
    "Focused context is better than loading the entire repository.",
    "Replanning is better than blindly retrying failures.",
    "Simplicity is preferred unless complexity is required.",
    "For huge app builds, do not include file contents or large tool_calls in the plan. Set tool_calls to [] and let the executor model generate each step's concrete tool calls.",
    "Keep step count between 4 and 6. For large feature work, prefer fewer broader steps and let the executor iterate within each step using small targeted edits. Each step should fit in a single concise response. The runtime executes one step per model response and advances; combine related work (e.g. schema + auth + middleware) into one step rather than splitting them.",
    "Do not ask for broad repository context. Plan from the lean context below and create an inspection step when more details are needed.",
    "Acceptance-first rule: inspect visible task specs, README files, tests, validation scripts, and expected output formats before choosing an implementation path. Prefer the smallest correct implementation that satisfies the user's acceptance criteria and visible tests.",
    "Do not over-engineer a full parser/runtime when the task only requires producing a documented output shape or passing a validation harness. Use real checks, but keep the solution as simple as the acceptance criteria allow.",
    "Keep steps concrete and ordered: environment, scaffold, backend slice, frontend slice, model-managed tests, Docker/docs, completion summary.",
    "If a prior plan was exhausted but the task is not complete, the next plan must continue from the latest incomplete deliverable rather than create another inspection-only plan.",
    "Each step should target a narrow objective, affect a limited number of files, have observable completion criteria, and fit comfortably within model context limits.",
    "If prior test/build/runtime checks failed, make the next plan reproduce/verify-oriented and set onFailure:\"request_patch\". The executor will stop and ask the parent to call patcher when a real patch is needed.",
    "Progress preservation is mandatory. If recent tool results show a subsystem already built, a file already generated, or a step already verified, do not restart earlier work unless later diagnostics invalidate it. Plan from the latest failing artifact/command forward.",
    "Testing is a normal execution step controlled by the model. Never use placeholder checks such as echo/printf success, true, exit 0, or scripts that only claim completion.",
    "Do not use no-test-success flags such as --passWithNoTests for testing; passing with zero discovered tests is not success.",
    "If execution failed, add investigation tasks when needed, simplify the approach when complexity caused instability, and never repeat an identical failing attempt.",
    "",
    "# Runtime State",
    `Planning pass: ${input.iteration + 1}/20`,
    `Workspace: ${input.contentPrep.index.workspaceRoot}`,
    `Environment:\n${environment}`,
    `Task:\n${input.prompt}`,
    `Compact file tree:\n${fileTree || "(empty)"}`,
    compactedHistory ? `Compacted prior observations:\n${compactedHistory}` : "Compacted prior observations: none.",
    `Lean planner context:\n${context || "(no high-signal files selected)"}`,
    `Recent tool results:\n${JSON.stringify(recentResults)}`,
    boundedFeedback.length ? `Verification feedback to fix:\n${boundedFeedback.join("\n\n---\n\n")}` : "Verification feedback to fix: none.",
    boundedFeedback.length
      ? "Repair scope lock: the next plan must primarily fix the latest failing check. Preserve existing project structure and manifests; inspect/edit only what the diagnostic points to unless investigation proves a broader cause."
      : "Repair scope lock: inactive.",
    input.negativeConstraints.length
      ? `Do not repeat:\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "No negative constraints from previous verification attempts.",
  ].join("\n\n");
}



export function buildPatchRequest(input: {
  prompt: string;
  currentStep?: ExecutionPlanStep;
  isFinalPlanStep?: boolean;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  contentPrep: ContentPrepResult;
  hypothesisRescueEnabled?: boolean;
}): Record<string, unknown> {
  const recentFailures = input.toolResults.filter((result) => !result.ok).slice(-5);
  const recentCommands = input.toolResults
    .filter((result) => result.name === "run_shell_command")
    .slice(-6)
    .map((result) => {
      const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
      return typeof args.cmd === "string" ? args.cmd : "";
    })
    .filter(Boolean);
  const filesHint = inferPatchFilesHint(input);
  const errorLogs = [
    ...recentFailures.map((result) => renderToolResultSnippet(result)),
    ...input.feedback.slice(-4),
    ...input.negativeConstraints.slice(-4).map((item) => `Do not repeat: ${item}`),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 12000);

  return {
    taskId: input.currentStep?.id ?? `patch-${stableHash(`${input.prompt}:${input.toolResults.length}:${errorLogs}`)}`,
    goal: input.currentStep
      ? `Patch current step '${input.currentStep.title}' for the overall task.`
      : "Patch the latest observed bug, failing check, or implementation gap.",
    scope: {
      filesHint,
      allowedDirs: inferAllowedDirs(input.contentPrep),
      forbiddenDirs: ["node_modules", ".git", "dist", "build", "coverage", ".reaper", "scratchpad"],
    },
    constraints: {
      preserveApi: true,
      avoidLargeRefactor: true,
      maxFilesChanged: 8,
      styleGuide: "Follow existing repository style. Prefer minimal, language-agnostic root-cause fixes over broad rewrites.",
    },
    failureContext: {
      errorLogs,
      failingTests: recentCommands.filter((cmd) => isVerificationLikeCommand(cmd)),
      reproductionSteps: recentCommands.slice(-4),
    },
    acceptanceCriteria: [
      "Make the smallest correct patch for the cited failure or implementation gap.",
      "Do not redesign unrelated systems or restart scaffolding.",
      "Run the narrowest meaningful test/build/runtime check for the changed behavior.",
      "If tests fail, inspect the cited diagnostics and adjust the patch instead of repeating unchanged commands.",
      "If the patch cannot be safely completed, return needs_parent_decision with no broad rewrite.",
    ],
    testCommandHints: recentCommands.filter((cmd) => isVerificationLikeCommand(cmd)).slice(-3),
    ...(input.hypothesisRescueEnabled === false ? {} : { hypothesisLedger: buildRescueHypothesisLedger(input.toolResults) }),
  };
}



export function normalizePatchRequest(
  patchRequest: Record<string, unknown>,
  input: {
    prompt: string;
    currentStep?: ExecutionPlanStep;
    toolResults: ToolResult[];
    contentPrep: ContentPrepResult;
    feedback: string[];
    negativeConstraints: string[];
    hypothesisRescueEnabled?: boolean;
  },
): Record<string, unknown> {
  const fallback = buildPatchRequest(input);
  const fallbackScope = fallback.scope && typeof fallback.scope === "object" ? (fallback.scope as Record<string, unknown>) : {};
  const incomingScope = patchRequest.scope && typeof patchRequest.scope === "object" ? (patchRequest.scope as Record<string, unknown>) : {};
  const topLevelFilesHint = Array.isArray(patchRequest.filesHint)
    ? patchRequest.filesHint.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const scopedFilesHint = Array.isArray(incomingScope.filesHint)
    ? incomingScope.filesHint.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const filesHint = uniqueStrings([...scopedFilesHint, ...topLevelFilesHint, ...parseStringArray(fallbackScope.filesHint)]).slice(0, 12);
  return {
    ...fallback,
    ...patchRequest,
    scope: {
      ...fallbackScope,
      ...incomingScope,
      filesHint,
    },
    taskId:
      typeof patchRequest.taskId === "string" && patchRequest.taskId.trim()
        ? patchRequest.taskId
        : typeof patchRequest.resumeFromStepId === "string" && patchRequest.resumeFromStepId.trim()
          ? patchRequest.resumeFromStepId
          : fallback.taskId,
    goal:
      typeof patchRequest.goal === "string" && patchRequest.goal.trim()
        ? patchRequest.goal
        : typeof patchRequest.reasonPatchNeeded === "string" && patchRequest.reasonPatchNeeded.trim()
          ? patchRequest.reasonPatchNeeded
          : fallback.goal,
  };
}



export function buildPatcherSubagentPrompt(input: {
  prompt: string;
  contentPrep: ContentPrepResult;
  currentStep?: ExecutionPlanStep;
  isFinalPlanStep?: boolean;
  toolResults: ToolResult[];
  feedback: string[];
  negativeConstraints: string[];
  patchRequest: Record<string, unknown>;
  runId: string;
  hypothesisRescueEnabled?: boolean;
}): string {
  const recentResults = input.toolResults.slice(-8).map((result) => capToolResultForPatcherPrompt(result as unknown as Record<string, unknown>));
  const compactedHistory = input.contentPrep.compactedHistory.compacted.slice(-4).join("\n");
  const fileTree = input.contentPrep.preparedContext.fileTree
    .filter((entry) => !/(^|\/)(node_modules|dist|build|coverage|\.git|\.reaper|scratchpad)\//.test(entry.replace(/\\/g, "/")))
    .slice(0, 120)
    .join("\n");
  const context = selectPatcherContextChunks(input)
    .map((chunk) => `FILE: ${chunk.path}\n${chunk.content.slice(0, patcherChunkBudget(chunk.path))}`)
    .join("\n\n---\n\n");
  const environment = renderFingerprintForPrompt(input.contentPrep.environmentFingerprint);
  const cappedPatchRequest = JSON.stringify(truncatePatchRequestForPrompt(input.patchRequest));

  return [
    "# Patcher / Rescuer Sub-Agent Tool",
    "You are the Patcher / Rescuer Sub-Agent inside an autonomous coding agent system.",
    "",
    "# Purpose",
    "The parent agent pauses normal execution and calls you when the flow hits a concrete problem: a bug, failed check, blocked action, missing artifact, service/environment issue, compatibility failure, partial implementation gap, or no-progress loop.",
    "Your job is not to plan the whole project. Your job is to pinpoint the current blocker, use local evidence plus targeted search when useful, apply the smallest reliable fix, verify it, and return only the information the parent needs to resume.",
    "",
    "# System Prompt",
    "You are the Patcher / Rescuer Sub-Agent inside a coding agent system.",
    "Your job is to make a focused repair for a specific blocker, bug, feature gap, environment issue, service issue, or failing verification signal.",
    "Do not redesign the system unless the parent explicitly asks. Prefer the smallest correct change. Preserve public APIs unless instructed otherwise. Follow the existing code style. Add or update tests when they prove the patch.",
    "",
    "# Fixed Internal Workflow",
    "1. Restate the current blocker internally as a precise problem statement grounded in the latest tool/verifier evidence.",
    "2. Inspect only relevant files, nearby tests, service logs, configs, or artifacts.",
    "3. If the failure depends on external library/tool/runtime behavior and local evidence is insufficient, use search_tools/web_search/web_fetch for official or high-signal documentation before choosing the fix.",
    "4. Diagnose the likely root cause or required implementation/recovery point.",
    "5. Apply a minimal patch or operational recovery action.",
    "6. Run targeted tests or a narrow real runtime/artifact/service check.",
    "7. If tests fail, iterate up to 3 times.",
    "8. When verified, emit advance_step or complete_task so the parent resumes the paused normal flow.",
    "9. Return only useful information to the parent agent.",
    "",
    "# Scope Discipline",
    renderOptimizationFrame({
      prompt: input.prompt,
      currentStep: input.currentStep,
      toolResults: input.toolResults,
      feedback: input.feedback,
      negativeConstraints: input.negativeConstraints,
      mode: "patcher",
    }),
    "",
    renderAgentSourceReliabilityPatterns("patcher"),
    "",
    "Avoid creative redesign. The parent/planner owns whole-project planning.",
    "Prefer smallest correct changes. Do not rewrite unrelated code. Do not touch formatting-only files unless needed. Keep existing style.",
    "Acceptance-first patching: inspect the visible spec/tests/error diagnostics and patch only what is needed to satisfy them. Do not turn a small compatibility/output-format fix into a full subsystem rewrite unless the failing tests require it.",
    "Legacy/vendor-source rule: if repeated patches to brittle legacy/vendor/generated code are causing new compile errors or structural corruption, stop patching that source and choose a non-invasive wrapper/shim/standalone implementation when it can satisfy the acceptance criteria.",
    "Scope lock: when Parent PatchRequest.scope.filesHint is non-empty, treat those files as the primary patch surface. Inspect other files only to understand APIs or imports. Do not modify files outside filesHint unless the latest diagnostics directly cite them or the patch is impossible without them; if you must broaden scope, say so in parentNeedsToKnow.",
    "Rescue mode: when Parent PatchRequest was synthesized by Reaper, treat failureContext/evidence as the current problem statement. Do not continue the old failing strategy; name the blocker, choose a new strategy, then repair and verify.",
    input.hypothesisRescueEnabled === false
      ? "Hypothesis-led rescue is disabled for this run."
      : "Hypothesis-led rescue is mandatory: choose one hypothesis from the ledger, run a discriminating check before editing, and use the observation to support, reject, or revise that hypothesis. Do not edit from an untested guess.",
    "Search discipline: use web_search/web_fetch only for general tool, package, API, runtime, protocol, or OS behavior. Do not search for benchmark/task answers, leaked solutions, expected final outputs, or task-specific shortcuts.",
    "When current evidence is a build/test/runtime failure, repair that failure first. Do not install unrelated packages, switch ecosystems, or replace working subsystems unless diagnostics prove that is necessary.",
    "When current evidence is a service/container issue, use the real service-control tools and logs/snapshots/exec paths. Do not create mock replacement services or hardcoded final responses.",
    "Provided dependency protection: sibling services and their image-provided files are source-of-truth dependencies. On a file-versus-directory entrypoint mismatch, use sandbox_service_control inspect_image before editing; use restore_from_image to recover a damaged/shadowed provided file. Do not fabricate replacement service logic.",
    "Dependency discovery must be targeted to the missing package/tool from the diagnostic. Do not inspect all dependency directories. Do not install packages just because a language has a common library if a small local implementation or existing dependency satisfies the acceptance criteria.",
    "Use the package manager for the active ecosystem only. Do not install a C/C++ header or source library with npm/pnpm/yarn; do not install JavaScript packages with pip/cargo/go. If the dependency is header-only/source-only, prefer an existing vendored file, a system package, a documented single-header/source download, or a small local implementation when acceptable.",
    "If a build tool reports that its cache/build directory belongs to a different source root or configuration, remove only that task-local build/cache directory and reconfigure from the intended source root before retrying. Do not repeatedly probe for the missing binary while the cache mismatch remains.",
    "For CMake or similar build systems, run the configure command with -S set to the directory that actually contains the build file. Do not assume the workspace root is the source root.",
    "If a command fails because an output binary/file does not exist, inspect the build target/config and compile failure before rerunning the missing binary.",
    "If a compiler/runtime diagnostic cites a missing or invalid include/import/module, the patch must remove or replace that exact failing reference from the active load/compile path. Do not create a wrapper/shim that still contains the same failing include/import.",
    "",
    "# Output Schema",
    "Return ONLY JSON with shape:",
    "{\"taskId\":\"string\",\"status\":\"patched_and_verified|patched_but_not_fully_verified|needs_parent_decision|failed_to_patch|patch_in_progress\",\"summary\":\"string\",\"filesChanged\":[\"path\"],\"behaviorChanged\":[\"change\"],\"testsRun\":[{\"command\":\"cmd\",\"result\":\"passed|failed|skipped\",\"importantOutput\":\"short optional\"}],\"remainingRisks\":[\"risk\"],\"parentNeedsToKnow\":[\"note\"],\"tool_calls\":[ToolCall],\"diff\":\"optional short diff/description\"}",
    "Keep summary, behaviorChanged, remainingRisks, parentNeedsToKnow, and importantOutput short. Do not include long logs or long explanations in schema fields.",
    "Return as many tool_calls as needed to fix the blocker and verify the fix in the same response. Do not artificially split a repair across responses when the model can continue.",
    "For large or fragile source edits, prefer replace_in_file with startLine/endLine/content after reading the file. Avoid huge oldString values that make JSON brittle.",
    "If exact oldString contains quotes, braces, backslashes, or many lines, use line-range replace_in_file instead.",
    "If any exact replace/edit on a file failed with string-not-found, multiple-matches, or stale-current-text, read the file again and use line-range replace_in_file for the smallest affected lines. Do not attempt another exact oldString replacement on that file.",
    "Do not include diff unless it is very short. The parent can inspect files from tool results.",
    "Use status patch_in_progress while returning concrete tool_calls for the next patch/test batch.",
    "If you return patch_in_progress or patched_but_not_fully_verified after changing code or declaring filesChanged, your tool_calls should include the next smallest relevant build/test/check command unless the latest tool result is already a failed check you are directly fixing.",
    "Clear exit rule: when the patch is done and the relevant targeted test/build/runtime check passed, set status to patched_and_verified and include exactly one exit control tool: advance_step if parent work remains, or complete_task only if the entire user task is complete.",
    "Do not keep returning patch_in_progress after tests pass. Do not keep reading files after the patch is verified. Exit patch mode with advance_step/complete_task.",
    "Use patched_and_verified only when a real relevant check passed. If patched but a broad check is still pending, use patched_but_not_fully_verified and return the next concrete test/check tool call. If you cannot identify a concrete next test/check, return needs_parent_decision.",
    "Use needs_parent_decision when a larger architecture decision is required. Use failed_to_patch when three materially different patch attempts have failed.",
    input.isFinalPlanStep
      ? "This patcher step is the FINAL planned step. If the patch is verified and the whole user task is complete, include exactly one complete_task tool call with args.summary. If work remains, return concrete patch/test tool calls."
      : "This patcher step is not the final planned step. When the scoped patch is verified, include advance_step with concrete evidence so the parent can continue to the next step. Do not emit complete_task unless the whole user task is truly complete.",
    "",
    renderToolCallContract(input.runId),
    "",
    "# Parent PatchRequest",
    cappedPatchRequest,
    "",
    "# Overall User Task",
    input.prompt,
    "",
    "# Current Plan Step",
    input.currentStep
      ? JSON.stringify({
          id: input.currentStep.id,
          title: input.currentStep.title,
          instructions: input.currentStep.instructions,
          suggestedImplementation: input.currentStep.suggestedImplementation,
          testGuidance: input.currentStep.testGuidance,
        })
      : "No current step. Patch latest observed failure or gap.",
    "",
    "# Workspace Tree",
    fileTree || "(empty)",
    "",
    `# Environment\n${environment}`,
    "",
    compactedHistory ? `# Compacted Observations\n${compactedHistory}` : "# Compacted Observations\nnone",
    "",
    `# Relevant Context\n${context || "(no indexed context)"}`,
    "",
    `# Recent Tool Results\n${JSON.stringify(recentResults)}`,
    "",
    input.hypothesisRescueEnabled === false ? "# Rescue Hypothesis Ledger\ndisabled" : renderRescueHypothesisLedger(input.toolResults),
    "",
    input.feedback.length ? `# Feedback\n${input.feedback.join("\n\n---\n\n")}` : "# Feedback\nnone",
    "",
    input.negativeConstraints.length
      ? `# Do Not Repeat\n${input.negativeConstraints.map((item) => `- ${item}`).join("\n")}`
      : "# Do Not Repeat\nnone",
  ].join("\n\n");
}

const PATCHER_PROMPT_STRING_FIELDS = [
  "scope",
  "constraints",
  "failureContext",
  "evidence",
  "hypothesisLedger",
  "blockedStep",
  "reasonPatchNeeded",
] as const;
const PATCHER_PROMPT_STRING_FIELD_BUDGET = 1200;
const PATCHER_PROMPT_STRING_ARRAY_BUDGET = 4;
const PATCHER_PROMPT_STRING_ARRAY_ITEM_BUDGET = 600;
const PATCHER_PROMPT_TOOL_RESULT_OUTPUT_BUDGET = 1200;
const PATCHER_PROMPT_TOOL_RESULT_TEXT_BUDGET = 600;
const PATCHER_PROMPT_TOTAL_BUDGET = 18000;

export function truncatePatchRequestForPrompt(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    if (typeof value === "string") return truncateString(value, 2000);
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => truncatePatchRequestForPrompt(item));
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (PATCHER_PROMPT_STRING_FIELDS.includes(key as (typeof PATCHER_PROMPT_STRING_FIELDS)[number])) {
      const v = record[key];
      if (typeof v === "string") {
        next[key] = truncateString(v, PATCHER_PROMPT_STRING_FIELD_BUDGET);
      } else if (v && typeof v === "object") {
        next[key] = truncateNestedFailureContext(v);
      } else {
        next[key] = v;
      }
    } else if (Array.isArray(record[key])) {
      const arr = (record[key] as unknown[]).slice(0, PATCHER_PROMPT_STRING_ARRAY_BUDGET).map((item) => {
        if (typeof item === "string") return truncateString(item, PATCHER_PROMPT_STRING_ARRAY_ITEM_BUDGET);
        return truncatePatchRequestForPrompt(item);
      });
      next[key] = arr;
    } else if (record[key] && typeof record[key] === "object" && !Array.isArray(record[key])) {
      next[key] = truncatePatchRequestForPrompt(record[key]);
    } else if (typeof record[key] === "string") {
      next[key] = truncateString(record[key], 600);
    } else {
      next[key] = record[key];
    }
  }
  return next;
}

function truncateNestedFailureContext(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, PATCHER_PROMPT_STRING_ARRAY_BUDGET).map((item) => {
      if (typeof item === "string") return truncateString(item, PATCHER_PROMPT_STRING_ARRAY_ITEM_BUDGET);
      return truncatePatchRequestForPrompt(item);
    });
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (typeof v === "string") {
      out[key] = truncateString(v, PATCHER_PROMPT_STRING_FIELD_BUDGET);
    } else if (Array.isArray(v)) {
      out[key] = v.slice(0, PATCHER_PROMPT_STRING_ARRAY_BUDGET).map((item) =>
        typeof item === "string" ? truncateString(item, PATCHER_PROMPT_STRING_ARRAY_ITEM_BUDGET) : truncatePatchRequestForPrompt(item),
      );
    } else if (v && typeof v === "object") {
      out[key] = truncatePatchRequestForPrompt(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function truncateString(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated for patcher prompt budget]`;
}

export function capToolResultForPatcherPrompt(result: { name?: string; args?: unknown; output?: unknown; error?: unknown; stdout?: string; stderr?: string } | Record<string, unknown>): Record<string, unknown> {
  if (!result || typeof result !== "object") return { value: String(result).slice(0, PATCHER_PROMPT_TOOL_RESULT_TEXT_BUDGET) };
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = { name: r.name };
  if (r.toolCallId) out.toolCallId = r.toolCallId;
  if (r.ok !== undefined) out.ok = r.ok;
  if (r.args !== undefined) {
    out.args = typeof r.args === "string" ? truncateString(r.args, PATCHER_PROMPT_STRING_ARRAY_ITEM_BUDGET) : r.args;
  }
  if (r.error !== undefined) {
    out.error = typeof r.error === "string" ? truncateString(r.error, PATCHER_PROMPT_STRING_FIELD_BUDGET) : truncatePatchRequestForPrompt(r.error);
  }
  if (r.output !== undefined) {
    if (typeof r.output === "string") {
      out.output = truncateString(r.output, PATCHER_PROMPT_TOOL_RESULT_OUTPUT_BUDGET);
    } else {
      out.output = truncatePatchRequestForPrompt(r.output);
    }
  }
  if (typeof r.stdout === "string") out.stdout = truncateString(r.stdout, PATCHER_PROMPT_TOOL_RESULT_OUTPUT_BUDGET);
  if (typeof r.stderr === "string") out.stderr = truncateString(r.stderr, 400);
  if (typeof r.message === "string") out.message = truncateString(r.message, 400);
  return out;
}



export function parsePatcherSubagentResult(value: unknown): PatcherSubagentResult {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const statusValues = new Set<PatcherSubagentResult["status"]>([
    "patched_and_verified",
    "patched_but_not_fully_verified",
    "needs_parent_decision",
    "failed_to_patch",
    "patch_in_progress",
  ]);
  const status =
    typeof raw.status === "string" && statusValues.has(raw.status as PatcherSubagentResult["status"])
      ? (raw.status as PatcherSubagentResult["status"])
      : "patch_in_progress";
  const toolCalls = parseToolCallArray(raw.tool_calls, { context: "patcher subagent result", limit: 32 });
  return {
    taskId: typeof raw.taskId === "string" && raw.taskId.trim() ? raw.taskId : "patch-task",
    status,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    filesChanged: parseStringArray(raw.filesChanged),
    behaviorChanged: parseStringArray(raw.behaviorChanged),
    testsRun: parsePatcherTests(raw.testsRun),
    remainingRisks: parseStringArray(raw.remainingRisks),
    parentNeedsToKnow: parseStringArray(raw.parentNeedsToKnow),
    tool_calls: toolCalls,
    ...(typeof raw.diff === "string" && raw.diff.trim() ? { diff: raw.diff.slice(0, 8000) } : {}),
  };
}



export function parsePatcherTests(value: unknown): PatcherSubagentResult["testsRun"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PatcherSubagentResult["testsRun"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const result = record.result === "passed" || record.result === "failed" || record.result === "skipped" ? record.result : "skipped";
    return [
      {
        command: typeof record.command === "string" ? record.command : "",
        result,
        ...(typeof record.importantOutput === "string" && record.importantOutput.trim()
          ? { importantOutput: record.importantOutput.slice(0, 1000) }
          : {}),
      },
    ];
  });
}



export function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20) : [];
}

export function capPlannerField(value: string, max: number): string {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated for planner budget]`;
}



export function inferPatchFilesHint(input: {
  currentStep?: ExecutionPlanStep;
  toolResults: ToolResult[];
  contentPrep: ContentPrepResult;
}): string[] {
  const files = new Set<string>();
  const latestFailure = [...input.toolResults].reverse().find((result) => !result.ok);
  const latestDiagnosticFiles = latestFailure
    ? extractFilePathsFromFailure(latestFailure).filter((file) => !isGeneratedOrBuildPath(file))
    : [];
  if (latestDiagnosticFiles.length > 0) {
    return uniqueStrings(latestDiagnosticFiles).slice(0, 8);
  }

  for (const result of input.toolResults.slice(-8).filter((item) => !item.ok)) {
    for (const file of extractFilePathsFromFailure(result)) {
      if (!isGeneratedOrBuildPath(file)) files.add(file);
    }
  }
  if (files.size > 0) return [...files].slice(0, 10);

  for (const result of input.toolResults.slice(-12)) {
    const args = result.args && typeof result.args === "object" ? (result.args as Record<string, unknown>) : {};
    for (const key of ["path", "file", "filePath"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) files.add(value);
    }
    const text = String(renderToolResultForModel(result));
    for (const match of text.matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|cs|cpp|cc|cxx|c|h|hpp|hh|rb|php|swift|scala|md|yml|yaml|toml|ini|gradle|cmake|txt))(?:[:\s]|$)/g)) {
      if (match[1] && !/(^|\/)(node_modules|dist|build|coverage)\//.test(match[1])) files.add(match[1]);
    }
  }
  if (input.currentStep) {
    for (const match of `${input.currentStep.instructions} ${input.currentStep.suggestedImplementation ?? ""}`.matchAll(
      /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|py|go|rs|java|cpp|c|h|hpp|md|yml|yaml|toml))/g,
    )) {
      if (match[1]) files.add(match[1]);
    }
  }
  for (const chunk of input.contentPrep.preparedContext.chunks.slice(0, 4)) files.add(chunk.path);
  return [...files].slice(0, 12);
}



export function selectPatcherContextChunks(input: {
  contentPrep: ContentPrepResult;
  patchRequest: Record<string, unknown>;
}): ContentPrepResult["preparedContext"]["chunks"] {
  const filesHint = new Set<string>();
  if (Array.isArray(input.patchRequest.filesHint)) {
    for (const file of input.patchRequest.filesHint) {
      if (typeof file === "string") filesHint.add(file);
    }
  }
  const scope = input.patchRequest.scope;
  if (scope && typeof scope === "object" && Array.isArray((scope as Record<string, unknown>).filesHint)) {
    for (const file of (scope as { filesHint?: unknown[] }).filesHint ?? []) {
      if (typeof file === "string") filesHint.add(file);
    }
  }
  return [...input.contentPrep.preparedContext.chunks]
    .sort((a, b) => Number(!filesHint.has(a.path)) - Number(!filesHint.has(b.path)) || a.path.localeCompare(b.path))
    .slice(0, 8);
}



export function patcherChunkBudget(filePath: string): number {
  const base = path.basename(filePath).toLowerCase();
  if (/^(package\.json|cmakelists\.txt|makefile|pyproject\.toml|cargo\.toml|go\.mod)$/.test(base)) return 3000;
  if (/\.(test|spec)\./.test(base)) return 3200;
  return 2600;
}



export function selectPlannerToolResults(toolResults: ToolResult[]): ToolResult[] {
  const failed = toolResults.filter((result) => !result.ok).slice(-3);
  const latest = toolResults.slice(-2);
  const seen = new Set<string>();
  return [...failed, ...latest].filter((result) => {
    const key = result.toolCallId || `${result.name}:${JSON.stringify(result.args).slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}



export function selectPlannerContextChunks(contentPrep: ContentPrepResult): ContentPrepResult["preparedContext"]["chunks"] {
  const priority = (filePath: string): number => {
    const normalized = filePath.replace(/\\/g, "/");
    const base = path.basename(normalized).toLowerCase();
    if (/^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig\.json|vite\.config\.[jt]s|jest\.config\.[jt]s|dockerfile|docker-compose\.ya?ml|readme\.md|\.env\.example)$/i.test(base)) return 0;
    if (/(^|\/)(src|app|server|client|test|tests)\//.test(normalized) && /\.(ts|tsx|js|jsx|json|md|css|html)$/.test(normalized)) return 1;
    return 2;
  };

  return [...contentPrep.preparedContext.chunks]
    .filter((chunk) => priority(chunk.path) < 2)
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path))
    .slice(0, 4);
}



export function plannerChunkBudget(filePath: string): number {
  const base = path.basename(filePath).toLowerCase();
  if (base === "package.json" || base.endsWith("config.js") || base.endsWith("config.ts") || base === "tsconfig.json") {
    return 1200;
  }
  return 700;
}



export function compactPlannerFileTree(fileTree: string[]): string[] {
  const important = fileTree.filter((entry) => {
    const normalized = entry.replace(/\\/g, "/");
    if (/\.(png|jpe?g|gif|svg|ico|webp|map|db|sqlite|lock)$/.test(normalized)) return false;
    if (/(^|\/)(dist|build|coverage|node_modules)\//.test(normalized)) return false;
    return /(^|\/)(package\.json|tsconfig\.json|vite\.config\.[jt]s|jest\.config\.[jt]s|Dockerfile|docker-compose\.ya?ml|README\.md|src\/|server\/|client\/|test\/|tests\/)/.test(normalized);
  });
  return important.slice(0, 80);
}



export function parsePlannerSubagentPlan(value: unknown): PlannerSubagentPlan {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const installs = Array.isArray(raw.installs)
    ? raw.installs.flatMap((item): PlannerSubagentPlan["installs"] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const manager = typeof record.manager === "string" && record.manager.trim() ? record.manager : "none";
        const packages = Array.isArray(record.packages)
          ? record.packages.filter((pkg): pkg is string => typeof pkg === "string" && pkg.trim().length > 0)
          : [];
        const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason : "Required by plan.";
        return [{ manager, packages, reason }];
      })
    : [];

  const steps = Array.isArray(raw.steps)
    ? raw.steps.flatMap((item, index): ExecutionPlanStep[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const instructions =
          typeof record.instructions === "string" && record.instructions.trim()
            ? record.instructions
            : "Execute this planned task step.";
        const title = typeof record.title === "string" && record.title.trim() ? record.title : `Step ${index + 1}`;
        const stepText = `${record.id ?? ""}\n${title}\n${instructions}\n${record.suggestedImplementation ?? ""}`;
        const parsedType = isPlanStepType(record.type) ? record.type : "command";
        const semanticType = normalizePlanStepType(parsedType, stepText);
        const successCriteria = parsePlannerStringArray(record.successCriteria ?? record.success_criteria);
        const advancementEvidence = parsePlannerStringArray(record.advancementEvidence ?? record.advancement_evidence);
        const filesHint = parsePlannerStringArray(record.filesHint ?? record.files_hint ?? record.files);
        const commands = parsePlannerStringArray(record.commands ?? record.commandHints ?? record.command_hints);
        const toolCalls = parseOptionalPlannerToolCalls(record.tool_calls, index);
        return [
          {
            id: typeof record.id === "string" && record.id.trim() ? record.id : `step-${index + 1}`,
            title,
            instructions,
            suggestedImplementation:
              capPlannerField(
                typeof record.suggestedImplementation === "string" && record.suggestedImplementation.trim()
                  ? record.suggestedImplementation
                  : synthesizeSuggestedImplementation(semanticType, stepText, commands, filesHint),
                600,
              ),
            testGuidance:
              capPlannerField(
                typeof record.testGuidance === "string" && record.testGuidance.trim()
                  ? record.testGuidance
                  : synthesizeTestGuidance(semanticType, commands),
                400,
              ),
            successCriteria: successCriteria.length
              ? successCriteria.map((item) => capPlannerField(item, 300)).slice(0, 6)
              : synthesizeSuccessCriteria(semanticType, stepText),
            advancementEvidence: advancementEvidence.length ? advancementEvidence : synthesizeAdvancementEvidence(semanticType, commands),
            ...(filesHint.length ? { filesHint } : {}),
            ...(commands.length ? { commands } : {}),
            type: semanticType,
            ...(isPlanStepOnFailure(record.onFailure) ? { onFailure: record.onFailure } : { onFailure: "request_patch" as const }),
            agent: "executor" as const,
            tool_calls: toolCalls,
          },
        ];
      })
    : [];

  if (steps.length === 0) {
    throw new Error("Planner subagent output did not include steps.");
  }

  return {
    installs,
    steps: steps.slice(0, 6),
    testGuidance: typeof raw.testGuidance === "string" && raw.testGuidance.trim() ? raw.testGuidance : "Run relevant automated tests and build checks.",
  };
}



export function parseOptionalPlannerToolCalls(value: unknown, stepIndex: number): ToolCall[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  try {
    return parseToolCallArray(value, { context: `planner subagent step ${stepIndex + 1}`, limit: 8 });
  } catch {
    return [];
  }
}



export function isPlanStepType(value: unknown): value is PlannerStepType {
  return value === "inspect" || value === "command" || value === "test" || value === "verify" || value === "review" || value === "finalize";
}



export function normalizePlanStepType(type: PlannerStepType, text: string): PlannerStepType {
  const normalized = text.toLowerCase();
  if (type === "finalize") return "finalize";
  const startsReadOnly = /^\s*(?:inspect|analyze|read|list|search|grep|understand|examine|identify|document)\b/.test(normalized);
  const startsOperational = /^\s*(?:fix|patch|repair|port|migrat|implement|create|write|edit|replace|build|compile|run|install|start|stop|scaffold|generate|produce|convert)\b/.test(normalized);
  const directMutationOrOperation = /\b(?:fix|patch|repair|port|migrat|implement|create|write|edit|replace|install|start|stop|scaffold)\b/.test(normalized);
  const buildOrRunOperation = startsOperational || /\b(?:run|execute)\s+(?:the\s+)?(?:command|script|test|tests|build|converter|server|application|app|binary|program)\b/.test(normalized);
  const hardMutationOrOperation = directMutationOrOperation || buildOrRunOperation;
  const producerOperation = /\b(?:generate|produce|convert)\s+(?:all|every|each|the|required|output|outputs|files?|models?|records?|artifacts?)\b/.test(normalized);
  const mutatesOrOperates = hardMutationOrOperation || producerOperation;
  const realTest = /\b(?:pytest|jest|vitest|mocha|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|unit test|integration test|e2e test)\b/.test(normalized);
  const verifiesAcceptance = /\b(?:verify|validate|acceptance|schema|output check|compliance|compare|matches expected|smoke check|final check)\b/.test(normalized);
  const readOnlyDiscovery = /\b(?:inspect|analyze|read|list|search|grep|understand|examine|identify|document)\b/.test(normalized) && !mutatesOrOperates && !realTest && !verifiesAcceptance;
  if (startsReadOnly && !directMutationOrOperation && !producerOperation && !realTest) return "inspect";
  if (readOnlyDiscovery) return "inspect";
  if (realTest) return "test";
  if (/\b(?:fix|patch|repair|port|compatib|migrat|implement|create|write|edit|replace|generate|produce|convert|build|compile|run)\b/.test(normalized)) {
    return "command";
  }
  if (verifiesAcceptance) return "verify";
  if (/\b(?:review|inspect generated|check diff)\b/.test(normalized)) return "review";
  return type;
}



export function parsePlannerStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
}



export function synthesizeSuggestedImplementation(
  type: NonNullable<ExecutionPlanStep["type"]>,
  text: string,
  commands: string[],
  filesHint: string[],
): string {
  const filePart = filesHint.length ? `Focus files/paths: ${filesHint.join(", ")}. ` : "";
  const commandPart = commands.length ? `Useful command hints: ${commands.join(" && ")}. ` : "";
  if (type === "inspect") return `${filePart}${commandPart}Read only the specific files or directories needed for this step; do not mutate files.`;
  if (type === "test" || type === "verify") return `${filePart}${commandPart}Run the narrowest real non-placeholder check and capture concrete pass/fail evidence.`;
  if (type === "finalize") return "Emit complete_task only after all required deliverables and checks are complete.";
  return `${filePart}${commandPart}Make the smallest concrete task-facing change for this step, then run a narrow build/runtime/output check before advancing.`;
}



export function synthesizeTestGuidance(type: NonNullable<ExecutionPlanStep["type"]>, commands: string[]): string {
  if (commands.length) return `Use or adapt these command hints for validation: ${commands.join(" && ")}`;
  if (type === "inspect") return "Advance only after the required facts/files are identified.";
  if (type === "finalize") return "Do not finalize unless the latest meaningful check passed or testing is explicitly unavailable with evidence.";
  return "Run a real build/test/runtime/output check for this step; placeholder success commands are invalid.";
}



export function synthesizeSuccessCriteria(type: NonNullable<ExecutionPlanStep["type"]>, text: string): string[] {
  if (type === "inspect") return ["The required files, APIs, specs, inputs, or diagnostics are identified with concrete evidence."];
  if (type === "test" || type === "verify") return ["A real task-local validation/check command passes.", "Any failure has concrete diagnostics for repair."];
  if (type === "finalize") return ["complete_task is emitted only after the full requested task is complete."];
  return ["The step's requested file/tool/output/build change exists.", "A narrow relevant check passes or produces concrete repair diagnostics."];
}



export function synthesizeAdvancementEvidence(type: NonNullable<ExecutionPlanStep["type"]>, commands: string[]): string[] {
  if (type === "inspect") return ["Specific file paths, API names, specs, inputs, or diagnostics discovered."];
  if (type === "finalize") return ["Final successful check evidence and complete_task summary."];
  if (commands.length) return [`Successful result from: ${commands[0]}`];
  return ["Changed/generated artifact evidence plus latest successful build/test/runtime/output check."];
}



export function isPlanStepOnFailure(value: unknown): value is NonNullable<ExecutionPlanStep["onFailure"]> {
  return value === "request_patch" || value === "needs_replan" || value === "abort";
}

/**
 * Phase T3.11 Wave 2a — `persistExecutionPlan` was a previously-undefined name
 * referenced by engine.ts at three call sites. It has two call signatures:
 *   (a) `await persistExecutionPlan(workspaceRoot, runId, plan)` — persists the
 *       full plan and derives a progress record (currentStepIndex=0, completedStepIds=[], failed=false).
 *   (b) `await persistExecutionPlan(workspaceRoot, runId, progress)` — persists
 *       a partial progress record directly.
 * Both call sites existed in engine.ts before this wave but were latent bugs
 * (function was never defined). This implementation preserves the pre-wave
 * "fails silently or with type error" behavior for call (a), and the explicit
 * progress-record behavior for call (b).
 */
/**
 * Cache-stable system-prompt prefix for sub-agent calls (planner, patcher,
 * executor, repair, simplify-recovery, simple-executor).
 *
 * Anthropic/OpenRouter/Codex prompt caching uses the literal prefix bytes as
 * the cache key. By keeping this string BYTE-STABLE across calls (same role,
 * same constant rules, same tool contract), providers that support prompt
 * caching will reuse the cached prefix for every model call in a run.
 *
 * This string is intentionally:
 *   - identical for every call within the same run
 *   - free of run-specific state (workspace, prompt, plan, feedback, env)
 *   - free of date/time/timestamp tokens
 *
 * Sub-agent callers pass this as the `system` field on the GenerateRequest.
 * Per-call dynamic state (plan, recent tool results, feedback, env fingerprint)
 * stays in the user message.
 *
 * Codex / Claude Code style: the system prompt is the "agent contract" — the
 * rules and tool surface. The user prompt is the "task state" — the live data
 * the model needs to act on.
 */
let cachedSystemPromptPrefix: string | undefined;

/**
 * Stable tool examples — cache-friendly substring that's identical across
 * calls. Excludes the dynamic `sandbox_service_control` examples and any
 * runId-discovered tool entries (those vary per run).
 */
const STABLE_TOOL_EXAMPLES = [
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
].join("\n");

export function getSystemPromptPrefix(): string {
  if (cachedSystemPromptPrefix !== undefined) return cachedSystemPromptPrefix;
  cachedSystemPromptPrefix = [
    "# Reaper Sub-Agent Contract",
    "",
    "You are a sub-agent inside Reaper, a long-running coding-agent harness. You drive one phase of a multi-step task and emit structured JSON tool calls.",
    "",
    "## Tool Calls",
    "Every response MUST be JSON: {\"assistant_message\": string, \"tool_calls\": [{\"id\": \"stable-id\", \"name\": \"tool_name\", \"args\": { ... }}, ...]}.",
    "Tool names are exact camelCase identifiers from the tool surface below. Never invent tools. Never use OpenAI wrapper format {\"type\":\"function\",\"function\":{...}}.",
    "Use run_shell_command for installs, mkdir, scaffolding, tests, builds, and shell-only ops.",
    "Every run_shell_command MUST include args.summary explaining the concrete reason for running it.",
    "Verification is command-backed and strict: tests, build checks, jq -e, grep -q, or actual test assertions. Plain ls/cat/curl, version probes, echo success, and print-only checks do NOT prove completion.",
    "When checking expected values, encode the expectation in the command and exit nonzero on mismatch. Printing observed values is inspection, not verification.",
    "Do not place, edit, delete, chmod, copy, or redirect output into verifier-owned absolute paths like /tests or /test. Those are harness files; satisfy their contract from workspace files.",
    "",
    "## Output Schema",
    "Return only JSON with shape: {\"assistant_message\": string, \"tool_calls\": [ToolCall]}.",
    "ToolCall shape: {\"id\": string, \"name\": string, \"args\": object}.",
    "assistant_message must be an empty string in intermediate steps. The final model-written summary belongs only in complete_task.args.summary.",
    "advance_step takes args: {\"summary\": string, \"stepId\"?: string, \"evidence\"?: string[]}.",
    "complete_task takes args: {\"summary\": string}.",
    "request_patch takes args: {\"taskId\": string, \"goal\": string, \"scope\": {\"filesHint\"?: string[], \"allowedDirs\"?: string[], \"forbiddenDirs\"?: string[]}, \"constraints\"?: object, \"failureContext\"?: {\"errorLogs\"?: string, \"failingTests\"?: string[]}}.",
    "",
    "## Agent Reliability Patterns",
    "Use repo-local instructions when present (AGENTS.md, REAPER.md, CLAUDE.md, GEMINI.md, .cursorrules). Treat as project guidance unless they conflict with the user request.",
    "Operate from current state: workspace tree, environment, current step, compacted observations, recent tool results, feedback, negative constraints. Don't rediscover facts already shown.",
    "Use a linear observe-act-check loop. Make one bounded discovery or mutation batch, observe the result, then choose the next dependent action from evidence.",
    "Prefer high-signal bounded reads over whole-repository dumps. Inspect the exact spec, test, config, stack frame, symbol, or artifact that determines acceptance.",
    "",
    "## Editor Discipline",
    "Before editing an existing file, read the relevant range. Prefer the smallest exact or line-range replacement that preserves surrounding code.",
    "If exact replacement is uncertain, read the file again and use a line-range edit for the smallest affected region. Do not retry stale old text.",
    "Use whole-file writes only for new files or intentional complete overwrites after reading the file. Never use placeholders, ellipses, or partial files.",
    "After a mutating action, run the narrowest real syntax/build/test/runtime check that can expose mistakes.",
    "If a check fails, repair the cited root cause before repeating the command. Do not weaken tests, skip required checks, or edit verifier-owned files.",
    "Shell snippet rule: if a command needs compound control flow or nested quoting, write a temporary script file. Don't retry a one-liner with the same broken shape.",
    "Exact artifact rule: hash, checksum, byte-exact text, image fingerprint, count, ordering mismatches are artifact correctness failures. Inspect the comparator, then produce deterministic outputs.",
    "Service lifecycle rule: a process being running is not readiness. After start/restart, probe with wait_ready + bounded task-facing probe command before declaring success.",
    "",
    "## Reaper Modes (read by the harness)",
    "Planner: emits a 4-6 step plan with type labels (inspect/command/test/verify/review/finalize). The runtime uses the type to gate artifact obligations and command gating.",
    "Executor: drives one step end-to-end. Write code, run typecheck/lint/tests, fix issues, advance or finalize.",
    "Patcher: makes a minimal targeted patch in response to a patchRequest. One diagnosis, one patch, one targeted check.",
    "Repair: targeted fix on a single failed artifact without replanning.",
    "Recovery (simplify): collapse complexity to the externally visible contract. Use small adapters if internals keep failing.",
    "",
    "## Acceptance Discipline",
    "Do not emit complete_task until a real build/test/lint/runtime check has passed or testing is explicitly unavailable with evidence. Placeholder commands (echo success, true, exit 0) do not count as testing.",
    "Do not weaken tests or use --passWithNoTests. Passing with zero discovered tests is not success.",
    "If execution failed, make the next action reproduce/verify-oriented and request_patch if a real patch is needed.",
    "Progress preservation is mandatory: if recent tool results show a subsystem already built, do not restart earlier work unless later diagnostics invalidate it.",
    "",
    "## Tool Examples (canonical call shapes)",
    "Every tool call MUST be exactly {\"id\":\"stable-id\",\"name\":\"tool_name\",\"args\":{...}}.",
    "Do NOT use OpenAI wrappers such as {\"type\":\"function\",\"function\":{\"name\":\"...\",\"arguments\":{...}}}.",
    "Use camelCase argument names exactly as shown. Do not use snake_case aliases, nested file objects, or keys such as command/new_content/from_lines/to_lines.",
    "Do not place, edit, delete, chmod, copy, or redirect output into verifier-owned absolute paths like /tests or /test. Those are harness files; satisfy their contract from workspace files.",
    "For every run_shell_command, include args.summary with the concrete reason for running it now.",
    STABLE_TOOL_EXAMPLES,
  ].join("\n");
  return cachedSystemPromptPrefix;
}

/**
 * Per-role system-prompt extension. Combines the stable prefix with
 * role-specific rules. Cached separately so the prefix cache hit rate is
 * maximized across planner/patcher/executor calls.
 */
const roleSpecificSystemExtension = new Map<string, string>();

function getRoleSpecificExtension(role: "planner" | "patcher" | "executor" | "repair" | "recovery"): string {
  let cached = roleSpecificSystemExtension.get(role);
  if (cached !== undefined) return cached;
  switch (role) {
    case "planner":
      cached = [
        "",
        "## Planner Discipline",
        "Separate architecture from editing. Study the request and visible context, then give the executor clear instructions, likely files, command hints, success evidence, and boundaries.",
        "Do not include full replacement files, long code listings, or giant patches in the plan. The executor owns concrete file edits.",
        "Plan small acceptance-evidence steps: inspect only what is missing, implement narrow behavior, run the smallest real check, repair cited failures, then finalize.",
        "When prior execution failed, plan forward from the latest failing artifact or diagnostic. Preserve passed work.",
      ].join("\n");
      break;
    case "patcher":
      cached = [
        "",
        "## Patcher Discipline",
        "Keep patcher responses focused: one diagnosis, one minimal patch surface, and one targeted check when possible. Exit patch mode once the relevant check passes.",
      ].join("\n");
      break;
    case "repair":
      cached = [
        "",
        "## Repair Discipline",
        "In repair mode, use the latest failure evidence as the source of truth. Make the smallest concrete fix and validate it. Do not replan unless repeated evidence proves the current step is structurally wrong.",
      ].join("\n");
      break;
    case "recovery":
      cached = [
        "",
        "## Recovery Discipline",
        "In recovery mode, collapse complexity to the externally visible contract. If internals keep failing, prefer a small adapter, wrapper, shim, or standalone boundary implementation that can be verified honestly.",
      ].join("\n");
      break;
    case "executor":
    default:
      cached = "";
      break;
  }
  roleSpecificSystemExtension.set(role, cached);
  return cached;
}

/**
 * Returns the full system prompt for a given sub-agent role.
 * Combines the byte-stable prefix (cacheable) with the role-specific rules.
 */
export function buildSystemPromptForRole(role: "planner" | "patcher" | "executor" | "repair" | "recovery"): string {
  const prefix = getSystemPromptPrefix();
  const extension = getRoleSpecificExtension(role);
  return extension ? `${prefix}\n${extension}` : prefix;
}

export async function persistExecutionPlan(
  workspaceRoot: string,
  runId: string,
  planOrProgress: { currentStepIndex: number; completedStepIds: string[]; failed: boolean } | unknown[],
): Promise<void> {
  // Call signature (b): progress object.
  if (planOrProgress && typeof planOrProgress === "object" && !Array.isArray(planOrProgress) &&
      "currentStepIndex" in (planOrProgress as Record<string, unknown>)) {
    const p = planOrProgress as { currentStepIndex: number; completedStepIds: string[]; failed: boolean };
    await persistExecutionPlanProgress(workspaceRoot, runId, {
      currentStepIndex: p.currentStepIndex,
      completedStepIds: p.completedStepIds,
      failed: p.failed,
    });
    // Also write a human-readable PLAN.md next to .reaper/PLAN.md.
    if (Array.isArray(planOrProgress)) {
      await writePlanMarkdown(workspaceRoot, planOrProgress, p);
    } else {
      // Progress only — read the existing plan from .reaper if possible.
      try {
        const { readFile } = await import("node:fs/promises");
        const existing = JSON.parse(await readFile(`${workspaceRoot}/.reaper/execution-plan.json`, "utf8"));
        if (Array.isArray(existing)) {
          await writePlanMarkdown(workspaceRoot, existing, p);
        }
      } catch {
        // ignore: PLAN.md is best-effort
      }
    }
    return;
  }
  // Call signature (a): plan array — derive a starting-progress record.
  // (Original behavior: this branch was never reachable because the function was undefined;
  // we now preserve the latent behavior by writing a starting-progress record.)
  const plan = planOrProgress as unknown[];
  await persistExecutionPlanProgress(workspaceRoot, runId, {
    currentStepIndex: 0,
    completedStepIds: [],
    failed: false,
  });
  await writePlanMarkdown(workspaceRoot, plan, {
    currentStepIndex: 0,
    completedStepIds: [],
    failed: false,
  });
}

/**
 * Write the human-readable PLAN.md to `<workspaceRoot>/.reaper/PLAN.md`.
 * This mirrors the Claude Code / Pi / Codex pattern: the plan lives next to
 * the workspace, is durable across crashes, and is inspectable from the
 * outside. Updated on every planner step (initial plan, replan, completion).
 */
export async function writePlanMarkdown(
  workspaceRoot: string,
  plan: unknown[],
  progress: { currentStepIndex: number; completedStepIds: string[]; failed: boolean },
): Promise<void> {
  if (!Array.isArray(plan) || plan.length === 0) return;
  const mdLines: string[] = [];
  mdLines.push("# Reaper Plan");
  mdLines.push("");
  mdLines.push(`_Run ${progress.completedStepIds.length}/${plan.length} complete${progress.failed ? " (run failed)" : ""}_`);
  mdLines.push("");
  plan.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const step = raw as Record<string, unknown>;
    const id = typeof step.id === "string" && step.id ? step.id : `step-${index + 1}`;
    const title = typeof step.title === "string" && step.title ? step.title : id;
    const type = typeof step.type === "string" && step.type ? step.type : "command";
    const isComplete = progress.completedStepIds.includes(id);
    const isCurrent = index === progress.currentStepIndex;
    const marker = isComplete ? "[x]" : isCurrent ? "[>]" : "[ ]";
    mdLines.push(`## ${marker} ${index + 1}. ${title}`);
    mdLines.push("");
    mdLines.push(`- **id**: ${id}`);
    mdLines.push(`- **type**: ${type}`);
    const instructions = typeof step.instructions === "string" ? step.instructions : "";
    if (instructions) {
      mdLines.push("");
      mdLines.push("**Instructions:**");
      mdLines.push("");
      mdLines.push(instructions);
    }
    const impl = typeof step.suggestedImplementation === "string" ? step.suggestedImplementation : "";
    if (impl) {
      mdLines.push("");
      mdLines.push(`<details><summary>Suggested implementation</summary>\n\n${impl}\n\n</details>`);
    }
    const success = Array.isArray(step.successCriteria) ? step.successCriteria.filter((c): c is string => typeof c === "string") : [];
    if (success.length > 0) {
      mdLines.push("");
      mdLines.push("**Success criteria:**");
      mdLines.push("");
      for (const criterion of success) mdLines.push(`- ${criterion}`);
    }
    mdLines.push("");
  });

  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const reaperDir = `${workspaceRoot}/.reaper`;
    await mkdir(reaperDir, { recursive: true });
    await writeFile(`${reaperDir}/PLAN.md`, mdLines.join("\n"), "utf8");
  } catch {
    // PLAN.md is best-effort: never let a write failure break the run.
  }
}

/**
 * Persist the current plan as JSON so progress-only writes (step completion)
 * can re-render PLAN.md without needing the plan in their input.
 * Stored at `<workspaceRoot>/.reaper/execution-plan.json`.
 */
export async function persistPlanJson(workspaceRoot: string, plan: unknown[]): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const reaperDir = `${workspaceRoot}/.reaper`;
    await mkdir(reaperDir, { recursive: true });
    await writeFile(`${reaperDir}/execution-plan.json`, JSON.stringify(plan, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Read the most recently persisted plan from .reaper/execution-plan.json.
 * Returns undefined if the file is missing or malformed.
 */
export async function loadPlanJson(workspaceRoot: string): Promise<unknown[] | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(`${workspaceRoot}/.reaper/execution-plan.json`, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Update PLAN.md to reflect current step-completion progress. Called after
 * each step is marked complete (Claude Code / Pi style). Re-renders the
 * file from the persisted plan + current progress.
 */
export async function updatePlanMarkdownProgress(
  workspaceRoot: string,
  progress: { currentStepIndex: number; completedStepIds: string[]; failed: boolean },
): Promise<void> {
  const plan = await loadPlanJson(workspaceRoot);
  if (!plan) return;
  await writePlanMarkdown(workspaceRoot, plan, progress);
}
