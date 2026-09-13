/**
 * Sandbox policy for the Reaper runtime.
 *
 * Inspired by Codex CLI / Claude Code / Aider, Reaper exposes a small,
 * explicit set of permission modes that constrain which tools and shell
 * commands the agent can run without escalation. The policy is evaluated
 * inside `SandboxPolicy.evaluate()` BEFORE the tool executes and produces
 * a `SandboxDecision` with a `verdict` and the reason.
 *
 * Modes:
 *
 * - `read_only`     — only read-only tools and read-only shell allowed; writes
 *                    require a human approval.
 * - `workspace_write` — the default. Reads, workspace writes, and shell
 *                    commands that don't escape the workspace are allowed.
 *                    Network and out-of-workspace writes still require
 *                    approval.
 * - `network_disabled` — workspace_write + no commands that touch the
 *                    network (curl, wget, ssh, fetch, etc.).
 * - `danger_full_access` — no restrictions. Used for explicit, one-shot
 *                    dangerous operations the user has signed off on.
 *
 * The escape hatch for a call that would be denied is the approval flow the
 * runtime already owns: the executor raises an approval request over the
 * app-server and the operator decides. There is no model-facing tool that
 * grants its own permission — a tool the agent calls to authorise itself is a
 * tool that can be talked out of saying no.
 */

import type { ToolCall } from "../tools/types.js";

export type SandboxMode =
  | "read_only"
  | "workspace_write"
  | "network_disabled"
  | "danger_full_access";

export type SandboxVerdict =
  | "allow"
  | "deny"
  | "needs_human_approval";

export interface SandboxDecision {
  verdict: SandboxVerdict;
  reason: string;
  ruleId?: string;
  /**
   * Optional list of alternative modes where this tool call would be
   * allowed, so the cockpit can suggest: "switch to workspace_write to
   * permit this call without human approval".
   */
  allowedIn?: SandboxMode[];
}

/**
 * Tools that are always read-only — they never mutate the workspace, the
 * network, or any external state. They are unconditionally allowed in
 * every mode except `danger_full_access` (which we treat as the same
 * allow list, since the only "deny" comes from policy violations).
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "file_view",
  "file_find",
  "grep_search",
  "list_directory",
  "skim_file",
  "inspect_environment",
  "git_status",
  "git_diff",
  "search_tools",
  "update_plan",
  "update_todo",
  "advance_step",
  "web_search",
  "web_fetch",
]);

/**
 * Tools that this policy allows unconditionally, because this policy cannot
 * see what they do.
 *
 * `eval` runs JavaScript with the whole Node platform behind it. Every call it
 * makes through `tools.*` is turned into a real `ToolCall` and dispatched
 * through the same executor that produced this evaluation — so this policy runs
 * again on the inner call, with the same mode, and a script reaching for
 * `tools.write_file` under `read_only` gets exactly the error a direct
 * `write_file` would have got.
 *
 * **Everything else a script can do is not visible here.** `fs.writeFileSync`,
 * `child_process`, `fetch`, an npm package — none of it passes through this
 * function, and none of it can be inspected from a tool name and a `code`
 * string. So under `read_only`, `tools.write_file` is refused and
 * `fs.writeFileSync` is not: a model that wants to write can write. That is not
 * a subtlety, it is the design — Code Mode was built without a sandbox on
 * purpose, and the note in `src/tools/code/node-runtime.ts` is where the
 * reasoning lives.
 *
 * Which means this entry is a deliberate concession rather than a conclusion:
 * the alternative is denying the container outright, and that would take Code
 * Mode away from `read_only` entirely — including the read-only analysis (grep,
 * read, filter, aggregate) that is the feature's most obvious use. Allowing it
 * and letting `tools.*` carry the mode's intent is the smaller lie of the two.
 * It should not be read as a security boundary, because it isn't one.
 */
const COMPOSITE_TOOLS: ReadonlySet<string> = new Set([
  "eval",
]);

const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "file_edit",
  "edit_file",
  "delete_file",
  "create_checkpoint",
  "restore_checkpoint",
]);

const MUTATING_SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
]);

/**
 * Network-touching command patterns used by `network_disabled` mode and
 * the network classifier. Conservative — when in doubt, treat as
 * network so we err on the side of safety.
 */
const NETWORK_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b(?:\s|$)/,
  /\bnc\s+-/,
  /\bhttp(s)?:\/\//i,
  /\bgit\s+(?:push|pull|fetch|clone|remote)\b/,
  /\bnpm\s+(?:publish|install|add|update)\b/,
  /\bbrew\s+(?:install|tap|update)\b/,
  /\bpip\s+install\b/,
  /\bapt(?:-get)?\s+(?:install|update|upgrade)\b/,
  /\b(web_search|web_fetch|fetch_url|download)\b/i,
];

const FORBIDDEN_ROOT_PATTERNS: readonly RegExp[] = [
  /rm\s+-rf\s+\/(?:\s|$)/,
  /dd\s+.*\bof=\/dev\//,
  />\s*\/dev\/sda/,
  /chmod\s+(-R\s+)?777\s+\//,
  /:\(\)\s*\{/,
  /mkfs\./,
];

/**
 * Shell command patterns that count as "workspace write" — they touch
 * files inside the workspace. These are allowed in `workspace_write` and
 * above.
 */
const WORKSPACE_WRITE_SHELL_PATTERNS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run|install|add|remove|update|exec)\b/,
  /\b(?:node|python3?|ruby|php|perl|deno|bun)\b\s+\S+\.(?:m?[jt]s|js|cjs|py|rb|php|pl|sh)\b/,
  /\b(?:git|hg|svn)\s+(?:commit|add|checkout|switch|restore|reset|mv|rm|tag|merge|rebase|push|pull)\b/,
  /\b(?:touch|cp|mv|rm|install|mkdir|rmdir)\b/,
  /\b(?:sed|awk)\s+-i\b/,
  /\bchmod\b/,
  /\bchown\b/,
  />\s*\S/,
  /\|\s*\S/,
  /\btee\s+/,
];

export interface SandboxPolicyOptions {
  mode: SandboxMode;
  /**
   * If true, mutating shell commands and workspace-write tools are sent to
   * the operator for approval instead of being auto-allowed. The default is
   * to auto-allow within the active mode's risk class.
   */
  requireHumanApproval?: boolean;
}

export class SandboxPolicy {
  private mode: SandboxMode;
  private readonly requireHumanApproval: boolean;

  constructor(options: SandboxPolicyOptions) {
    this.mode = options.mode;
    this.requireHumanApproval = options.requireHumanApproval ?? false;
  }

  getMode(): SandboxMode {
    return this.mode;
  }

  setMode(mode: SandboxMode): void {
    this.mode = mode;
  }

  evaluate(call: ToolCall): SandboxDecision {
    // Hard-deny checks apply first, regardless of mode. These are
    // commands that should never be allowed in any normal session.
    if (call.name === "bash") {
      const cmd: string = typeof call.args?.cmd === "string" ? call.args.cmd : "";
      for (const pattern of FORBIDDEN_ROOT_PATTERNS) {
        if (pattern.test(cmd)) {
          return {
            verdict: "deny",
            reason: "This shell command matches a hard-deny pattern (destructive root-level operation).",
            ruleId: "forbidden_root_pattern",
          };
        }
      }
    }

    // Read-only tools are always allowed in every mode.
    if (READ_ONLY_TOOLS.has(call.name)) {
      return { verdict: "allow", reason: "Read-only tool", ruleId: "read_only" };
    }

    // Composite tools carry no authority of their own; see COMPOSITE_TOOLS.
    if (COMPOSITE_TOOLS.has(call.name)) {
      return { verdict: "allow", reason: "Composite tool — its own calls are gated individually", ruleId: "composite" };
    }

    // Tool classes that mutate state.
    if (MUTATING_SHELL_TOOLS.has(call.name)) {
      return this.evaluateMutatingTool(call);
    }
    if (WORKSPACE_WRITE_TOOLS.has(call.name)) {
      return this.evaluateWorkspaceWriteTool(call);
    }

    // Unknown tools default to deny so the policy is fail-closed.
    return {
      verdict: "deny",
      reason: `Tool '${call.name}' is not in the sandbox allow list for mode '${this.mode}'.`,
      ruleId: "unknown_tool",
    };
  }

  private evaluateWorkspaceWriteTool(call: ToolCall): SandboxDecision {
    switch (this.mode) {
      case "read_only":
        return {
          verdict: "needs_human_approval",
          reason: `Mode 'read_only' forbids '${call.name}'. Switch to 'workspace_write' or request human approval.`,
          ruleId: "read_only_blocks_write",
          allowedIn: ["workspace_write", "network_disabled", "danger_full_access"],
        };
      case "workspace_write":
      case "network_disabled":
      case "danger_full_access":
        if (this.requireHumanApproval) {
          return {
            verdict: "needs_human_approval",
            reason: `Mode '${this.mode}' requires explicit human approval for '${call.name}'.`,
            ruleId: "require_human_approval",
          };
        }
        return { verdict: "allow", reason: "Workspace write permitted by mode", ruleId: "workspace_write" };
    }
  }

  private evaluateMutatingTool(call: ToolCall): SandboxDecision {
    if (call.name === "bash") {
      const cmd: string = typeof call.args?.cmd === "string" ? call.args.cmd : "";
      // Network-touching commands are denied in `network_disabled` and require
      // approval in `workspace_write` (network is a higher risk class).
      if (this.commandTouchesNetwork(cmd)) {
        if (this.mode === "network_disabled") {
          return {
            verdict: "deny",
            reason: "Network access is disabled in 'network_disabled' mode.",
            ruleId: "network_disabled",
            allowedIn: ["workspace_write", "danger_full_access"],
          };
        }
        if (this.mode === "workspace_write") {
          return {
            verdict: "needs_human_approval",
            reason: "Network access in 'workspace_write' mode requires human approval.",
            ruleId: "workspace_write_blocks_network",
            allowedIn: ["network_disabled", "danger_full_access"],
          };
        }
      }
      // Pure workspace-write shell is allowed in any mode except read_only.
      if (this.mode === "read_only") {
        return {
          verdict: "needs_human_approval",
          reason: "Mode 'read_only' forbids 'bash'. Switch to 'workspace_write' or request approval.",
          ruleId: "read_only_blocks_shell",
          allowedIn: ["workspace_write", "network_disabled", "danger_full_access"],
        };
      }
      if (this.requireHumanApproval) {
        return {
          verdict: "needs_human_approval",
          reason: `Mode '${this.mode}' requires explicit human approval for shell commands.`,
          ruleId: "require_human_approval",
        };
      }
      // Workspace-write shell command is allowed.
      if (this.isWorkspaceWriteShell(cmd) || this.mode === "danger_full_access") {
        return { verdict: "allow", reason: "Workspace shell permitted", ruleId: "workspace_write" };
      }
      // Unknown / read-only-but-not-allowlisted shell: in workspace_write, ask
      // for human approval instead of denying silently.
      if (this.mode === "workspace_write") {
        return {
          verdict: "needs_human_approval",
          reason: "Shell command is not in the workspace-write allow list; human approval required.",
          ruleId: "shell_not_in_allowlist",
          allowedIn: ["network_disabled", "danger_full_access"],
        };
      }
      // network_disabled with non-network, non-workspace command — still ask.
      return {
        verdict: "needs_human_approval",
        reason: "Shell command not in the network-disabled allow list; human approval required.",
        ruleId: "shell_not_in_allowlist",
        allowedIn: ["workspace_write", "danger_full_access"],
      };
    }
    return { verdict: "deny", reason: "Unknown mutating tool", ruleId: "unknown_mutating" };
  }

  private commandTouchesNetwork(cmd: string): boolean {
    return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd));
  }

  private isWorkspaceWriteShell(cmd: string): boolean {
    return WORKSPACE_WRITE_SHELL_PATTERNS.some((pattern) => pattern.test(cmd));
  }
}

/**
 * Convenience helper used by the executor / classifier integration to
 * evaluate a tool call against a sandbox policy and convert the decision
 * into the existing `PermissionClassification` shape that the rest of
 * Reaper already understands.
 */
export function sandboxToClassification(decision: SandboxDecision): {
  outcome: "safe" | "dangerous" | "needs_confirmation";
  reasoning: string;
  confidence: number;
  ruleMatch?: string;
} {
  const ruleMatch = decision.ruleId;
  if (decision.verdict === "allow") {
    return { outcome: "safe", reasoning: decision.reason, confidence: 1, ...(ruleMatch ? { ruleMatch } : {}) };
  }
  if (decision.verdict === "needs_human_approval") {
    return {
      outcome: "needs_confirmation",
      reasoning: decision.reason,
      confidence: 0.95,
      ...(ruleMatch ? { ruleMatch } : {}),
    };
  }
  return {
    outcome: "dangerous",
    reasoning: decision.reason,
    confidence: 1,
    ...(ruleMatch ? { ruleMatch } : {}),
  };
}
