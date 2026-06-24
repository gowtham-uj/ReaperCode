/**
 * planner/planner.ts — the unified Planner sub-agent.
 *
 * The Planner is the only sub-agent the main agent has access to. It
 * runs in one of three modes, all sharing the same {@link PlannerPlan}
 * schema and the same model role (`"planner"`):
 *
 *   - **initial** — takes the user task and returns a brand-new plan.
 *     Called by the main model via `delegate_to_planner(mode="initial")`
 *     on the first turn.
 *   - **replan** — takes the current plan, completed steps, tool
 *     results, and failures; returns an updated plan. Called when the
 *     main model decides the current plan is no longer workable
 *     (a step is stuck, a tool keeps failing, a verification failed,
 *     or the task is broader than the original plan covered).
 *   - **update_todo** — same input as `replan`, but the model is told
 *     to return only a delta against the current plan. Called when
 *     only the current step's todo needs updating and the rest of the
 *     plan is stable.
 *
 * The Planner never edits files, never runs shell commands, never
 * declares completion. It only classifies, decomposes, sequences, and
 * defines verification.
 *
 * Helpers (no model call):
 *   - {@link mergePlanWithCompletedSteps} — preserves successful steps
 *     verbatim across replans (runtime invariant).
 *   - {@link shouldReplan} — cheap deterministic decision gate for
 *     callers that want to know whether the current plan is likely
 *     broken.
 *   - {@link renderPlannerPlanForExecutor} — formats a plan for the
 *     executor prompt.
 */

import { randomUUID } from "node:crypto";
import { generateStructuredJson } from "../model/json-response.js";
import type { ModelGateway, ModelRole } from "../model/types.js";
import {
  PlannerSchemaError,
  tryRepairPlannerPlan,
  validatePlannerPlan,
  type PlannerPlan,
  type PlanStep,
} from "./schema.js";
import { REAPER_PLANNER_SYSTEM_PROMPT, REAPER_REPLANNER_SYSTEM_PROMPT } from "./prompts.js";
import type { TrajectoryLogger } from "../logging/trajectory.js";

/* -------------------------------------------------------------------------- */
/* Modes                                                                      */
/* -------------------------------------------------------------------------- */

export type PlannerMode = "initial" | "replan" | "update_todo";

/* -------------------------------------------------------------------------- */
/* Input shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface PlannerContext {
  /** Workspace root the planner can mention in inspection steps. */
  workspaceRoot?: string;
  /** Compact file tree the planner can lean on (optional). */
  fileTree?: string[];
  /** Free-form notes the executor / replanner may want surfaced. */
  notes?: string[];
}

export interface ReplannerCompletedStep {
  step: PlanStep;
  /** Per-step outcome. */
  outcome: "success" | "failed" | "blocked" | "skipped";
  /** Optional one-line note explaining what happened. */
  note?: string;
}

export interface ReplannerFailure {
  /** Failure category surfaced by the runtime. */
  kind:
    | "tool_error"
    | "blocked_tool"
    | "failed_test"
    | "verification_failed"
    | "blocked_policy"
    | "other";
  /** Optional id of the step that failed. */
  stepId?: string;
  /** Human-readable error message. */
  message: string;
}

export interface RunPlannerInput {
  modelGateway: ModelGateway;
  /** Model role to resolve (default: "planner"). */
  role?: ModelRole;
  /** Planner mode. */
  mode: PlannerMode;
  /** The original user task (verbatim). */
  prompt: string;
  /** Workspace + repo context. `initial` mode only. */
  context?: PlannerContext;
  /** `replan` and `update_todo` modes. */
  currentPlan?: PlannerPlan;
  completedSteps?: ReplannerCompletedStep[];
  /** Recent tool results, serialized as compact strings. */
  recentToolResults?: string[];
  failures?: ReplannerFailure[];
  /** Max output tokens. Defaults to 8192. */
  maxTokens?: number;
  /**
   * Trajectory context. When provided, the planner invocation is
   * logged to the trajectory as a `subagent_prompt` event with
   * `subagent: "planner"`, `role: "planner"`, and the resolved
   * model name. The caller should pass the same handle used by the
   * main engine so planner calls are visible alongside the main
   * model's turns.
   */
  trajectory?: {
    trajectoryLogger: TrajectoryLogger;
    runId: string;
    sessionId: string;
    traceId: string;
  };
}

export class PlannerError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PlannerError";
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Default maximum number of replans before the runtime gives up. */
export const DEFAULT_MAX_REPLANS = 3;

/* -------------------------------------------------------------------------- */
/* User-message renderers                                                     */
/* -------------------------------------------------------------------------- */

function renderInitialUserMessage(input: RunPlannerInput): string {
  const sections: string[] = [];
  sections.push("# User Task");
  sections.push(input.prompt.trim());
  if (input.context?.workspaceRoot) {
    sections.push("");
    sections.push(`# Workspace\n${input.context.workspaceRoot}`);
  }
  if (input.context?.fileTree && input.context.fileTree.length > 0) {
    sections.push("");
    sections.push("# Compact File Tree");
    sections.push(input.context.fileTree.slice(0, 200).join("\n"));
  }
  if (input.context?.notes && input.context.notes.length > 0) {
    sections.push("");
    sections.push("# Notes");
    for (const note of input.context.notes) {
      sections.push(`- ${note}`);
    }
  }
  sections.push("");
  sections.push("Return only the JSON plan object. No markdown, no prose.");
  return sections.join("\n");
}

function renderReplanUserMessage(input: RunPlannerInput): string {
  const sections: string[] = [];
  sections.push("# Original User Task");
  sections.push(input.prompt.trim());
  if (input.currentPlan) {
    sections.push("");
    sections.push("# Current Plan");
    sections.push(JSON.stringify(input.currentPlan, null, 2));
  }
  if (input.completedSteps && input.completedSteps.length > 0) {
    sections.push("");
    sections.push("# Completed Steps");
    for (const entry of input.completedSteps) {
      const note = entry.note ? ` — ${entry.note}` : "";
      sections.push(`- ${entry.step.id} [${entry.outcome}] ${entry.step.title}${note}`);
    }
  } else {
    sections.push("");
    sections.push("# Completed Steps\n(none)");
  }
  if (input.recentToolResults && input.recentToolResults.length > 0) {
    sections.push("");
    sections.push("# Recent Tool Results");
    for (const tr of input.recentToolResults.slice(-12)) {
      sections.push(`- ${tr}`);
    }
  }
  if (input.failures && input.failures.length > 0) {
    sections.push("");
    sections.push("# Failures / Errors");
    for (const f of input.failures) {
      const step = f.stepId ? ` (step ${f.stepId})` : "";
      sections.push(`- [${f.kind}]${step} ${f.message}`);
    }
  } else {
    sections.push("");
    sections.push("# Failures / Errors\n(none)");
  }
  sections.push("");
  sections.push(
    "Return the updated plan as the JSON object. Preserve completed successful steps by re-emitting them unchanged when they should still be in the plan. Do not include markdown.",
  );
  return sections.join("\n");
}

function renderUpdateTodoUserMessage(input: RunPlannerInput): string {
  const sections: string[] = [];
  sections.push("# Original User Task");
  sections.push(input.prompt.trim());
  if (input.currentPlan) {
    sections.push("");
    sections.push("# Current Plan");
    sections.push(JSON.stringify(input.currentPlan, null, 2));
  }
  if (input.completedSteps && input.completedSteps.length > 0) {
    sections.push("");
    sections.push("# Completed Steps");
    for (const entry of input.completedSteps) {
      const note = entry.note ? ` — ${entry.note}` : "";
      sections.push(`- ${entry.step.id} [${entry.outcome}] ${entry.step.title}${note}`);
    }
  }
  if (input.recentToolResults && input.recentToolResults.length > 0) {
    sections.push("");
    sections.push("# Recent Tool Results");
    for (const tr of input.recentToolResults.slice(-6)) {
      sections.push(`- ${tr}`);
    }
  }
  sections.push("");
  sections.push(
    "Return the updated plan as the JSON object. Re-emit every existing step that should stay in the plan unchanged. Only modify the steps that need to change for the current-step todo update. Do not include markdown.",
  );
  return sections.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Merge a model's updated plan with the previously completed steps.
 *
 * The replanner is told to preserve completed steps, but a model can
 * still emit them with edits. To make "preserve" a runtime invariant
 * rather than a prompt hope, we merge by step id:
 *   - any step that was completed successfully stays in the merged
 *     plan with its original instructions / hints — the model can not
 *     accidentally rewrite history.
 *   - any step that completed with `failed` / `blocked` is dropped
 *     unless the model explicitly re-emits it as a repair step.
 *   - any other step emitted by the model (new id) is taken as-is.
 */
export function mergePlanWithCompletedSteps(
  modelPlan: PlannerPlan,
  completed: ReplannerCompletedStep[],
): PlannerPlan {
  const completedByStep = new Map<string, ReplannerCompletedStep>();
  for (const entry of completed) {
    completedByStep.set(entry.step.id, entry);
  }

  const mergedSteps: PlanStep[] = [];
  const seenIds = new Set<string>();

  // Pass 1: re-emit every successful step first so it appears at its
  // original position in the plan order. Use the original step, not
  // whatever the model emitted for that id, so the executor can't
  // drift away from the contract it already satisfied.
  for (const entry of completed) {
    if (entry.outcome === "success") {
      mergedSteps.push(entry.step);
      seenIds.add(entry.step.id);
    }
  }

  // Pass 2: append model-emitted steps, skipping ones we've already
  // preserved or ones that previously failed/blocked.
  for (const step of modelPlan.plan) {
    if (seenIds.has(step.id)) continue;
    const prior = completedByStep.get(step.id);
    if (prior && (prior.outcome === "failed" || prior.outcome === "blocked")) {
      continue;
    }
    mergedSteps.push(step);
    seenIds.add(step.id);
  }

  return {
    ...modelPlan,
    plan: mergedSteps,
  };
}

/**
 * Decide whether the runtime should call the Replanner. Triggered on
 * the explicit failure categories the runtime already detects —
 * blocked tools, repeated test failures, verification fails, and
 * failed shell commands. Cheap and deterministic; no model call.
 */
export function shouldReplan(input: {
  blockedToolCount: number;
  failedTestCount: number;
  verificationFailed: boolean;
  recentShellErrors: number;
}): boolean {
  if (input.verificationFailed) return true;
  if (input.blockedToolCount >= 2) return true;
  if (input.failedTestCount >= 1) return true;
  if (input.recentShellErrors >= 3) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Trajectory logging                                                         */
/* -------------------------------------------------------------------------- */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "sk-***REDACTED***" },
  { pattern: /\bsk-cp-[A-Za-z0-9_-]{16,}/g, replacement: "sk-cp-***REDACTED***" },
  { pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/g, replacement: "Bearer ***REDACTED***" },
  { pattern: /[Aa]uthorization:\s*[^\n]+/g, replacement: "Authorization: ***REDACTED***" },
  { pattern: /\b(api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/gi, replacement: "$1=***REDACTED***" },
];

function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

async function logPlannerCall(
  trajectory: RunPlannerInput["trajectory"],
  systemPrompt: string,
  userPrompt: string,
  mode: PlannerMode,
  modelName: string | undefined,
  callKind: "delegated_by_main_model" | "engine_initial" | "engine_replan" | "engine_update_todo",
): Promise<void> {
  if (!trajectory) return;
  try {
    await trajectory.trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: trajectory.runId,
      session_id: trajectory.sessionId,
      trace_id: trajectory.traceId,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "subagent_prompt",
      level: "info",
      subagent: "planner",
      role: "planner",
      ...(modelName ? { model: modelName } : {}),
      system_prompt: redact(systemPrompt),
      user_prompt: redact(userPrompt),
      user_prompt_chars: userPrompt.length,
      call_id: randomUUID(),
      metadata: { mode, call_kind: callKind },
    });
  } catch {
    // Logging must never break a planner call.
  }
}

/* -------------------------------------------------------------------------- */
/* runPlanner — the unified entry point                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run the unified Planner sub-agent. Validates the model output
 * against {@link validatePlannerPlan} and repairs obvious JSON
 * damage via {@link tryRepairPlannerPlan} before throwing. The
 * returned plan is always schema-valid; the caller can rely on that
 * invariant.
 *
 * Behaviour by mode:
 *   - **initial** — produces a brand-new plan from the user task.
 *     The model's raw output IS the plan; no merge step.
 *   - **replan** — the model's output is merged with the completed
 *     successful steps via {@link mergePlanWithCompletedSteps} so
 *     successful steps are preserved verbatim.
 *   - **update_todo** — same merge as replan; the user message asks
 *     the model to emit a delta against the current plan, but the
 *     merge step is the same runtime invariant.
 */
export async function runPlanner(input: RunPlannerInput): Promise<PlannerPlan> {
  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new PlannerError("Planner requires a non-empty prompt");
  }
  if (input.mode !== "initial") {
    if (!input.currentPlan) {
      throw new PlannerError(`Planner mode=${input.mode} requires currentPlan`);
    }
  }

  const role: ModelRole = input.role ?? "planner";
  const maxTokens = input.maxTokens ?? 8192;

  const systemPrompt =
    input.mode === "initial" ? REAPER_PLANNER_SYSTEM_PROMPT : REAPER_REPLANNER_SYSTEM_PROMPT;
  const userMessage =
    input.mode === "initial"
      ? renderInitialUserMessage(input)
      : input.mode === "replan"
        ? renderReplanUserMessage(input)
        : renderUpdateTodoUserMessage(input);

  // Best-effort: resolve the model name for the trajectory log.
  let modelName: string | undefined;
  try {
    const resolved = await input.modelGateway.resolveRole(role);
    modelName = resolved.model;
  } catch {
    modelName = undefined;
  }

  await logPlannerCall(
    input.trajectory,
    systemPrompt,
    userMessage,
    input.mode,
    modelName,
    input.mode === "initial"
      ? "engine_initial"
      : input.mode === "replan"
        ? "engine_replan"
        : "engine_update_todo",
  );

  let raw: unknown;
  try {
    raw = await generateStructuredJson({
      modelGateway: input.modelGateway,
      role,
      system: systemPrompt,
      maxTokens,
      messages: [{ role: "user", content: userMessage }],
      parse: (value) => value,
    });
  } catch (error) {
    throw new PlannerError(
      `Planner model call failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  let parsed: PlannerPlan;
  try {
    parsed = validatePlannerPlan(raw);
  } catch (error) {
    if (error instanceof PlannerSchemaError) {
      const repaired = tryRepairPlannerPlan(raw);
      if (repaired) {
        parsed = repaired;
      } else {
        throw new PlannerError(
          `Planner output failed schema validation: ${error.message}`,
          error,
        );
      }
    } else {
      throw error;
    }
  }

  if (input.mode === "initial") {
    return parsed;
  }
  return mergePlanWithCompletedSteps(parsed, input.completedSteps ?? []);
}

/* -------------------------------------------------------------------------- */
/* Human-readable plan rendering                                              */
/* -------------------------------------------------------------------------- */

/**
 * Render a {@link PlannerPlan} as a compact human-readable summary.
 * Used by the runtime when surfacing the plan to the executor prompt
 * and by docs / logs.
 */
export function renderPlannerPlanForExecutor(plan: PlannerPlan): string {
  const lines: string[] = [];
  lines.push(`[planner] task_type=${plan.task_type} complexity=${plan.complexity} confidence=${plan.confidence}`);
  lines.push(`[planner] summary: ${plan.task_summary}`);
  if (plan.needs_initial_inspection) {
    lines.push("[planner] initial inspection required");
  }
  if (plan.assumptions.length > 0) {
    lines.push("[planner] assumptions:");
    for (const a of plan.assumptions.slice(0, 6)) lines.push(`  - ${a}`);
  }
  if (plan.ambiguities.length > 0) {
    lines.push("[planner] ambiguities:");
    for (const a of plan.ambiguities.slice(0, 6)) lines.push(`  - ${a}`);
  }
  if (plan.risks.length > 0) {
    lines.push("[planner] risks:");
    for (const r of plan.risks.slice(0, 6)) lines.push(`  - ${r}`);
  }
  if (plan.plan.length > 0) {
    lines.push("[planner] steps:");
    for (const step of plan.plan) {
      const deps = step.depends_on.length > 0 ? ` (after: ${step.depends_on.join(", ")})` : "";
      lines.push(`  ${step.id} [${step.type}] ${step.title}${deps}`);
      lines.push(`    goal: ${step.goal}`);
      if (step.success_criteria.length > 0) {
        lines.push(`    success: ${step.success_criteria.join("; ")}`);
      }
    }
  }
  if (plan.verification_strategy.required) {
    lines.push(`[planner] verification: ${plan.verification_strategy.success_signal}`);
    for (const cmd of plan.verification_strategy.commands) {
      lines.push(`  $ ${cmd}`);
    }
  } else {
    lines.push("[planner] verification: not required (per plan)");
  }
  if (plan.done_definition.length > 0) {
    lines.push("[planner] done when:");
    for (const d of plan.done_definition) lines.push(`  - ${d}`);
  }
  if (plan.executor_guidance.length > 0) {
    lines.push("[planner] executor guidance:");
    for (const g of plan.executor_guidance.slice(0, 8)) lines.push(`  - ${g}`);
  }
  return lines.join("\n");
}
