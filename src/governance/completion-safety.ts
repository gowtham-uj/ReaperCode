/**
 * Completion-safety gate for `complete_task`.
 *
 * `complete_task` is the only tool that ends a run. The runtime
 * engine already requires an `explicitVerification.ok === true`
 * flag before it commits the run (see the S3 hardening in
 * `src/runtime/engine.ts`). This module adds three additional
 * conditions on top of that:
 *
 *   1. The caller must be the root orchestrator. Subagents must
 *      report back to the root via the swarm's structured output
 *      and let the root call `complete_task`. This prevents a
 *      subagent from prematurely ending the run.
 *
 *   2. The shell history must be free of high-risk commands that
 *      ran without the explicit approval pathway. (The engine
 *      already audits every shell call; this is a redundant
 *      belt-and-braces gate at the ToolPolicy layer.)
 *
 *   3. There must be no outstanding human-approval request. A
 *      pending request is treated as "human is in control" and
 *      `complete_task` would steal their handle.
 *
 * The gate is invoked from `policy-engine.ts` whenever a
 * `complete_task` call is observed. It is the last gate the call
 * passes before being forwarded to the engine's existing
 * `validateCompletionSignal` check.
 */

import type { PolicyRole } from "./tool-metadata.js";

/* -------------------------------------------------------------------------- */
/*                              Public types                                  */
/* -------------------------------------------------------------------------- */

export interface CompletionContext {
  /** The role of the caller. Must be "root" to pass. */
  callerRole: PolicyRole | string;
  /** True iff the engine's explicit verification has passed. */
  explicitVerificationPassed: boolean;
  /** True iff an `request_human_approval` call is currently in-flight. */
  humanApprovalInFlight: boolean;
  /**
   * Set of recent shell commands (last N) classified as "high" risk
   * without a matching approval. The engine passes this in from its
   * audit log; the gate treats a non-empty set as a blocker.
   */
  unapprovedHighRiskCommands: string[];
  /**
   * If true, the caller is operating inside a known sandboxed
   * container that cannot reach the host. The engine sets this
   * when `safetyProfile === "allow_all"` AND the run is inside
   * a recognized sandbox (e.g. Terminal-Bench). Inside a
   * sandbox, the human-approval in-flight check is relaxed.
   */
  trustedSandbox: boolean;
}

export type CompletionDecision =
  | { allow: true; reason: string }
  | { allow: false; reason: string; code: CompletionDenialCode; blockers: string[] };

export type CompletionDenialCode =
  | "not_root"
  | "verification_missing"
  | "human_in_control"
  | "unapproved_high_risk"
  | "missing_context";

/* -------------------------------------------------------------------------- */
/*                            The gate itself                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns the verdict for whether a `complete_task` call should
 * be allowed. The function is pure (no side effects) so callers
 * can stage decisions in a trajectory and apply them on the
 * actual call site.
 */
export function canCompleteTask(ctx: CompletionContext): CompletionDecision {
  // 1. Root-only. Subagents cannot complete the run; they must
  //    hand back to the root via the swarm's structured output.
  if (ctx.callerRole !== "root") {
    return {
      allow: false,
      code: "not_root",
      reason: `complete_task is restricted to the root orchestrator; caller role is '${ctx.callerRole}'`,
      blockers: ["subagent_cannot_complete"],
    };
  }

  // 2. Verification must have run AND passed. The engine
  //    surfaces this via `explicitVerificationPassed`. The
  //    engine's existing `summarizeNode.canComplete` already
  //    checks this, but we duplicate it here as a defense in
  //    depth.
  if (!ctx.explicitVerificationPassed) {
    return {
      allow: false,
      code: "verification_missing",
      reason: "complete_task requires an explicit verification that has passed",
      blockers: ["verification_not_passed"],
    };
  }

  // 3. If a human is in control (an `request_human_approval` is
  //    in flight and not yet resolved), the agent must NOT
  //    complete the task — completing would imply the agent
  //    has the final say, when the human is still reviewing.
  if (ctx.humanApprovalInFlight && !ctx.trustedSandbox) {
    return {
      allow: false,
      code: "human_in_control",
      reason: "Human approval is in flight; wait for resolution before completing",
      blockers: ["human_approval_pending"],
    };
  }

  // 4. Unapproved high-risk commands. The engine should have
  //    blocked these in the executor, but we re-check here so
  //    that a future executor regression does not silently
  //    enable `complete_task` after a forbidden command.
  if (ctx.unapprovedHighRiskCommands.length > 0) {
    return {
      allow: false,
      code: "unapproved_high_risk",
      reason: `Cannot complete: ${ctx.unapprovedHighRiskCommands.length} unapproved high-risk command(s) in history`,
      blockers: ctx.unapprovedHighRiskCommands.slice(0, 3),
    };
  }

  return { allow: true, reason: "All completion-safety conditions satisfied" };
}
