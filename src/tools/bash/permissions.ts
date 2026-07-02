import { type BashInput } from "./schema.js";
import { classifyBashCommand } from "./classify.js";

export type SandboxMode = "read_only" | "workspace_write" | "network_disabled" | "danger_full_access";

export interface PermissionEvaluation {
  outcome: "allow" | "would_block" | "deny";
  reason: string;
  allowedIn?: SandboxMode[];
  ruleId?: string;
}

const MODE_ORDER: SandboxMode[] = ["read_only", "workspace_write", "network_disabled", "danger_full_access"];

// The permission check only inspects `command` (and optionally
// `description`). We accept a partial BashInput so callers in tests
// and policy modules can pass a minimal shape without the required
// `timeout` field.
type PermissionInput = Pick<BashInput, "command"> & Partial<Pick<BashInput, "description">>;

export function evaluateBashPermission(
  input: PermissionInput,
  mode: SandboxMode,
  _workspaceRoot: string,
  _cwd: string,
): PermissionEvaluation {
  const classification = classifyBashCommand(input.command);
  const description = input.description ?? input.command.slice(0, 80);

  if (mode === "danger_full_access") {
    if (classification.category === "dangerous") {
      return { outcome: "would_block", reason: `Even danger_full_access blocks destructive disk/root ops: ${classification.reason}`, allowedIn: [], ruleId: "bash_dangerous" };
    }
    return { outcome: "allow", reason: `danger_full_access allows ${description}`, ruleId: "bash_danger" };
  }

  if (classification.category === "dangerous") {
    return {
      outcome: "deny",
      reason: classification.reason,
      allowedIn: ["danger_full_access"],
      ruleId: "bash_dangerous",
    };
  }

  if (mode === "read_only") {
    if (!classification.readOnly) {
      return {
        outcome: "would_block",
        reason: `read_only mode blocks non-read commands: ${classification.reason}`,
        allowedIn: ["workspace_write", "network_disabled", "danger_full_access"],
        ruleId: "bash_read_only",
      };
    }
    return { outcome: "allow", reason: `read-only allowed: ${classification.reason}`, ruleId: "bash_read" };
  }

  if (mode === "network_disabled" && classification.network) {
    return {
      outcome: "would_block",
      reason: `network_disabled mode blocks network commands: ${classification.reason}`,
      allowedIn: ["danger_full_access"],
      ruleId: "bash_network_disabled",
    };
  }

  if (mode === "workspace_write" && classification.network) {
    return {
      outcome: "would_block",
      reason: `workspace_write mode requires network_disabled or danger_full_access for ${classification.reason}`,
      allowedIn: ["network_disabled", "danger_full_access"],
      ruleId: "bash_network_would_block",
    };
  }

  return { outcome: "allow", reason: `${mode} allows ${description}`, ruleId: "bash_allowed" };
}

export function escalateMode(mode: SandboxMode): SandboxMode | undefined {
  const idx = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[idx + 1];
}

export function isReadOnly(input: BashInput): boolean {
  return classifyBashCommand(input.command).readOnly;
}

export function isConcurrencySafe(input: BashInput): boolean {
  return isReadOnly(input);
}
