/**
 * tools/write/delegate-to-planner.ts — the main model's handle on the
 * Planner sub-agent. The main agent calls this with mode=initial on
 * the first turn; mode=replan or mode=update_todo on subsequent turns
 * when the plan needs to change.
 *
 * The tool is wired with the engine's runtime context at registration
 * time (modelGateway + state handle), so calling it does not require
 * the main model to know about the underlying state machine.
 */

import type { ModelGateway, ModelRole } from "../../model/types.js";
import { runPlanner, type PlannerMode, type PlannerContext, type ReplannerCompletedStep, type ReplannerFailure } from "../../planner/planner.js";
import type { PlannerPlan } from "../../planner/schema.js";
import type { DelegateToPlanArgs } from "./delegate-to-planner.types.js";

export interface DelegateToPlannerContext {
  /** Model gateway the planner calls into. */
  modelGateway: ModelGateway;
  /** Resolved model role for the planner (default "planner"). */
  role?: ModelRole;
  /** The original user task. */
  prompt: string;
  /** Optional initial-mode context. */
  context?: PlannerContext;
  /** Optional current plan; required for `replan` and `update_todo` modes. */
  currentPlan?: PlannerPlan;
  /** Optional completed steps for `replan` / `update_todo`. */
  completedSteps?: ReplannerCompletedStep[];
  /** Optional recent tool results. */
  recentToolResults?: string[];
  /** Optional failures observed by the main model. */
  failures?: ReplannerFailure[];
  /** Trajectory context (used by the planner for the subagent_prompt log). */
  trajectory?: {
    trajectoryLogger: import("../../logging/trajectory.js").TrajectoryLogger;
    runId: string;
    sessionId: string;
    traceId: string;
  };
}

export interface DelegateToPlannerResult {
  ok: boolean;
  mode: PlannerMode;
  plan: PlannerPlan;
  /** Human-readable summary of the plan. */
  summary: string;
  /** Error message if the planner call failed. */
  error?: string;
}

/**
 * Pure handler — no I/O beyond the planner's model call. The engine
 * wraps this with the runtime context at registration time. Returns
 * a JSON envelope the main model can read in its next turn.
 */
export async function handleDelegateToPlanner(
  ctx: DelegateToPlannerContext,
  args: DelegateToPlanArgs,
): Promise<DelegateToPlannerResult> {
  try {
    const plan = await runPlanner({
      modelGateway: ctx.modelGateway,
      ...(ctx.role ? { role: ctx.role } : {}),
      mode: args.mode,
      prompt: ctx.prompt,
      ...(ctx.context ? { context: ctx.context } : {}),
      ...(args.mode !== "initial" && ctx.currentPlan ? { currentPlan: ctx.currentPlan } : {}),
      ...(ctx.completedSteps ? { completedSteps: ctx.completedSteps } : {}),
      ...(ctx.recentToolResults ? { recentToolResults: ctx.recentToolResults } : {}),
      ...(ctx.failures ? { failures: ctx.failures } : {}),
      ...(ctx.trajectory ? { trajectory: ctx.trajectory } : {}),
    });
    return {
      ok: true,
      mode: args.mode,
      plan,
      summary: plan.task_summary,
    };
  } catch (e) {
    return {
      ok: false,
      mode: args.mode,
      plan: ctx.currentPlan ?? {
        task_summary: "(planner call failed; no plan returned)",
        task_type: "unknown",
        complexity: "low",
        needs_decomposition: false,
        needs_initial_inspection: false,
        confidence: "low",
        assumptions: ["The Planner sub-agent failed; no plan was produced."],
        ambiguities: ["Without a plan, the executor should fall back to direct tool use."],
        risks: ["Acting without a plan risks off-target edits."],
        plan: [],
        verification_strategy: {
          required: false,
          commands: [],
          success_signal: "no verification",
          minimum_evidence: [],
        },
        done_definition: ["Planner produced no plan; main model should proceed carefully."],
        executor_guidance: [
          "Do not emit a complete_task signal without strong evidence.",
          "If the user's task is trivial, you may proceed with direct tool use.",
        ],
      },
      summary: "Planner sub-agent failed.",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
