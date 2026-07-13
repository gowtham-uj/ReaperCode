/**
 * ToolPolicy: the entry-gate decision engine.
 *
 * The engine evaluates a single tool call against metadata, the caller's
 * role profile, and command risk for shell tools. The result is a single
 * `PolicyDecision` the executor can consume before dispatch.
 *
 * The engine is intentionally additive: a decision of "allow" is
 * the same as no decision. A decision of "deny" produces a
 * `ToolResult` with `ok: false` and a `code` that the existing
 * trajectory / model feedback path already understands. A
 * decision of "require_approval" returns a structured error that
 * the executor can route to the human-in-the-loop layer.
 *
 * The engine never throws. It always returns a decision. This
 * keeps the executor's flow simple and lets tests assert
 * deterministic outcomes without try/catch noise.
 *
 * Wiring (in `src/tools/executor.ts`):
 *   1. After the unknown-tool guard, before the existing
 *      `PermissionClassifier.classifyToolCall`.
 *   2. The executor threads the active role and the trusted-sandbox
 *      flag via `ToolExecutorOptions` (extended with optional
 *      `callerRole` and `trustedSandbox`).
 *   3. The executor's `bash` case additionally calls
 *      `classifyCommandRisk(args.cmd)` and combines the result
 *      with the engine's role-based check.
 */

import { getToolMetadata, hasToolMetadata, type RiskLevel, type PolicyRole, type ToolMetadata } from "./tool-metadata.js";
import { roleAllowsTool,  roleToleratesCommandRisk,  getRoleProfile } from "./role-profiles.js";
import { classifyCommandRisk, type ShellRisk, type ShellRiskFinding } from "./shell-risk.js";
import { getOrderingAdvisories, type OrderingAdvisory } from "./preferred-ordering.js";

/* -------------------------------------------------------------------------- */
/*                                Types                                       */
/* -------------------------------------------------------------------------- */

export type PolicyVerdict =
  | "allow"
  | "deny"
  | "require_approval";

export type PolicyDenyCode =
  | "no_metadata"           // tool not in TOOL_METADATA
  | "forbidden_in_role"     // role's forbidden_tools includes this tool
  | "forbidden_by_metadata" // ToolMetadata.forbidden_in_roles includes this role
  | "not_in_role_allowlist" // role's allowed_tools does not include this tool
  | "shell_risk_exceeded"   // command risk above the role's tolerance
  | "shell_approval_required" // high-risk command without trusted-sandbox
  | "approval_required"     // tool requires_approval and sandbox not trusted
  | "missing_context";      // the call had no usable args at all

export interface PolicyDecision {
  verdict: PolicyVerdict;
  /** Stable, machine-readable code. */
  code: PolicyDenyCode | "allow" | "approval_pending";
  /** Human-readable reason. Surfaced to the trajectory and, on
   *  deny, to the model as feedback. */
  reason: string;
  /** The role that was checked. */
  role: PolicyRole | string;
  /** Tool metadata (if the tool is in the metadata map). */
  metadata: ToolMetadata | null;
  /** Shell risk classification, if this was a shell call. */
  shellRisk: ShellRiskFinding | null;
  /** Advisory-only ordering notes. Never block. */
  advisories: OrderingAdvisory[];
}

/* -------------------------------------------------------------------------- */
/*                              Public context                                */
/* -------------------------------------------------------------------------- */

export interface PolicyEvaluationContext {
  /** The tool name. */
  toolName: string;
  /** The tool's argument map (already normalized). */
  args: Record<string, unknown> | undefined;
  /** The caller's role. Pass "root" for the main agent. */
  callerRole: PolicyRole | string;
  /**
   * If true, the run is inside a trusted sandbox where
   * high-risk commands may execute without per-call approval.
   * The engine sets this from `options.trustedSandbox` on the
   * executor; callers without that flag default to false.
   */
  trustedSandbox: boolean;
  /** Ordered list of recent tool names (for ordering advisories). */
  recentTools?: readonly string[];
  /** True iff this is a subagent call (suppress ordering advisories
   *  in some deployments). */
  isSubagentCall?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                              The engine                                    */
/* -------------------------------------------------------------------------- */

export function evaluateToolCall(ctx: PolicyEvaluationContext): PolicyDecision {
  const { toolName, args, callerRole, trustedSandbox } = ctx;
  const meta = hasToolMetadata(toolName) ? getToolMetadata(toolName) : null;

  // 0. Unknown tool. The executor's existing allowlist already
  //    handles this, but a defense-in-depth check at the policy
  //    layer means a future tool added to the registry but
  //    missing from the metadata is still gated.
  if (!meta) {
    return {
      verdict: "deny",
      code: "no_metadata",
      reason: `Tool '${toolName}' has no metadata in the ToolPolicy registry. Add it to src/governance/tool-metadata.ts before allowing it.`,
      role: callerRole,
      metadata: null,
      shellRisk: null,
      advisories: [],
    };
  }

  // 1. Role-based allow/deny.
  // 1a. forbidden_in_role: the role profile's forbidden_tools.
  const roleProfile = getRoleProfile(callerRole);
  if (roleProfile && roleProfile.forbidden_tools.includes(toolName)) {
    return {
      verdict: "deny",
      code: "forbidden_in_role",
      reason: `Role '${callerRole}' is structurally forbidden from calling '${toolName}' (role policy: ${roleProfile.description})`,
      role: callerRole,
      metadata: meta,
      shellRisk: null,
      advisories: [],
    };
  }

  // 1b. forbidden_in_roles from the tool's own metadata. This is
  //     a redundant belt-and-braces check; if the role profile
  //     permits and the metadata forbids, the metadata wins.
  if ((meta.forbidden_in_roles as readonly string[]).includes(callerRole)) {
    return {
      verdict: "deny",
      code: "forbidden_by_metadata",
      reason: `Tool '${toolName}' is explicitly forbidden for role '${callerRole}' in its metadata`,
      role: callerRole,
      metadata: meta,
      shellRisk: null,
      advisories: [],
    };
  }

  // 1c. Allowed check.
  if (!roleAllowsTool(callerRole as PolicyRole, toolName)) {
    return {
      verdict: "deny",
      code: "not_in_role_allowlist",
      reason: `Role '${callerRole}' does not allow '${toolName}'. Allowed tools for this role: ${roleProfile?.allowed_tools.slice(0, 8).join(", ") ?? "none"}${roleProfile && roleProfile.allowed_tools.length > 8 ? ", …" : ""}`,
      role: callerRole,
      metadata: meta,
      shellRisk: null,
      advisories: [],
    };
  }

  // 2. Per-tool approval metadata.
  if (meta.requires_approval && !trustedSandbox) {
    return {
      verdict: "require_approval",
      code: "approval_required",
      reason: `Tool '${toolName}' requires explicit human approval (requires_approval=true in metadata)`,
      role: callerRole,
      metadata: meta,
      shellRisk: null,
      advisories: [],
    };
  }

  // 3. Shell command risk. bash is the only tool
  //    whose `args.cmd` is itself a risk surface.
  let shellRisk: ShellRiskFinding | null = null;
  if (toolName === "bash") {
    const cmd = (args && typeof (args as Record<string, unknown>).cmd === "string")
      ? ((args as Record<string, unknown>).cmd as string)
      : "";
    shellRisk = classifyCommandRisk(cmd);
    // High-risk commands require approval unless the run is
    // inside a trusted sandbox. The engine surfaces this as
    // require_approval so the executor can route to the
    // human-approval tool. This gate runs BEFORE the
    // role-tolerance check so that a medium-tolerance role
    // (e.g. implementer) gets a require_approval (not a deny)
    // for a high-risk command; a low-only role still gets a
    // deny because it is structurally forbidden from running
    // shell at all (handled by the role allowlist above).
    if (shellRisk.risk === "high" && !trustedSandbox) {
      return {
        verdict: "require_approval",
        code: "shell_approval_required",
        reason: `Shell command classified as high-risk (${shellRisk.ruleId}: ${shellRisk.reason}). Trusted-sandbox mode is off.`,
        role: callerRole,
        metadata: meta,
        shellRisk,
        advisories: [],
      };
    }
    // For non-high risk, the role's tolerance decides. A
    // medium-tolerance role can run medium-risk commands; a
    // low-only role cannot.
    if (!roleToleratesCommandRisk(callerRole as PolicyRole, shellRisk.risk)) {
      return {
        verdict: "deny",
        code: "shell_risk_exceeded",
        reason: `Role '${callerRole}' cannot run a ${shellRisk.risk}-risk shell command (${shellRisk.ruleId}: ${shellRisk.reason})`,
        role: callerRole,
        metadata: meta,
        shellRisk,
        advisories: [],
      };
    }
  }


  // 5. Ordering advisories. Always advisory, never blocking.
  const advisories: OrderingAdvisory[] = [];
  if (ctx.recentTools) {
    advisories.push(
      ...getOrderingAdvisories({
        currentTool: toolName,
        recentTools: ctx.recentTools,
        isSubagentCall: ctx.isSubagentCall === true,
      }),
    );
  }

  return {
    verdict: "allow",
    code: "allow",
    reason: "All policy checks passed",
    role: callerRole,
    metadata: meta,
    shellRisk,
    advisories,
  };
}

/* -------------------------------------------------------------------------- */
/*                                Helpers                                     */
/* -------------------------------------------------------------------------- */

/**
 * Convenience: build a `ToolResult`-shaped denial so the executor
 * can return it directly. Kept here so the executor doesn't have
 * to know about the `PolicyDecision` shape.
 */
export function policyDecisionToDenyResult(
  decision: PolicyDecision,
  toolCallId: string,
  args: Record<string, unknown> | undefined,
  start: number,
): {
  ok: false;
  toolCallId: string;
  name: string;
  durationMs: number;
  args: Record<string, unknown> | undefined;
  error: { message: string; code: string };
} {
  return {
    ok: false,
    toolCallId,
    name: String(decision.role === "" ? "unknown" : (decision.metadata?.name ?? "unknown")),
    durationMs: Date.now() - start,
    args,
    error: {
      message: decision.reason,
      code: decision.code,
    },
  };
}

/** True iff a PolicyDecision blocks execution. */
export function isPolicyDenial(d: PolicyDecision): boolean {
  return d.verdict === "deny";
}

/** True iff a PolicyDecision requires human approval. */
export function isPolicyApprovalRequired(d: PolicyDecision): boolean {
  return d.verdict === "require_approval";
}
