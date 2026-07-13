/**
 * Role-based tool profiles for the ToolPolicy system.
 *
 * Each profile describes what tools a caller with a given role is
 * allowed to invoke, what additional constraints apply, and what
 * affordances (command-risk tolerance, completion rights, etc.) the
 * role carries. The eight profiles are:
 *
 *   1. Explorer    — read-only repo mapping
 *   2. Architect   — read-only planning
 *   3. Implementer — write + run + test
 *   4. Test        — write tests + run
 *   5. Reviewer    — read-only diff review
 *   6. Critic      — adversarial read-only
 *   7. Browser     — web/browser-only task
 *   8. Root        — the orchestrator itself
 *
 *
 * Profiles deliberately do not duplicate per-tool forbidden_in_roles
 * from `tool-metadata.ts` — when they overlap, the more restrictive
 * wins.
 */

import type { PolicyRole,  RiskLevel} from "./tool-metadata.js";
import { TOOL_METADATA, getToolMetadata } from "./tool-metadata.js";

/* -------------------------------------------------------------------------- */
/*                                Type surface                                */
/* -------------------------------------------------------------------------- */

export type CommandRiskTolerance = "low-only" | "medium" | "high";

export interface RoleProfile {
  role: PolicyRole;
  description: string;
  /** Tools the role is allowed to call. */
  allowed_tools: readonly string[];
  /** Tools the role is NEVER allowed to call, even if listed above. */
  forbidden_tools: readonly string[];
  /** Whether the role can mutate the workspace. */
  can_write: boolean;
  /** Whether the role can execute shell commands. */
  can_run_commands: boolean;
  /** Highest command risk the role may invoke without approval. */
  shell_risk_tolerance: CommandRiskTolerance;
  /** Whether the role's tool calls require an approval gate. */
  requires_approval: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                The eight profiles                          */
/* -------------------------------------------------------------------------- */

/** Common read-only tool set. */
const READ_ONLY_TOOLS: readonly string[] = [
  "read_file",
  "view_file",
  "list_directory",
  "grep_search",
  "skim_file",
  "inspect_environment",
  "web_search",
  "web_fetch",
  "get_tool_output",
  "search_tools",
  "task_list",
  "task_create",
  "task_update",
  "activate_skill",
];

/** Tools a write-capable role may also use. */
const WRITE_TOOLS: readonly string[] = [
  "write_file",
  "replace_in_file",
  "edit_file",
  "replace_symbol",
  "delete_file",
  "bash",
  "read_background_output",
  "signal_process",
  "write_to_process",
];

/** Skill authoring (5 tools). Drafts only — no trust gate. */
const SKILL_AUTHORING_TOOLS: readonly string[] = [
  "create_skill",
  "test_skill",
  "reload_skills",
];

/** Extension authoring (5 tools, JS only). Trust + enable are root-only. */
const EXTENSION_AUTHORING_TOOLS: readonly string[] = [
  "create_extension",
  "validate_extension",
  "reload_extensions",
];

/** Hook authoring (2 tools, observe-only). Approve + enforce are root-only. */
const HOOK_AUTHORING_TOOLS: readonly string[] = [
  "create_hook",
  "list_hooks",
  "reload_hooks",
];

export const ROLE_PROFILES: Record<PolicyRole, RoleProfile> = {
  /* 1) Explorer — read-only repo mapping. */
  explorer: {
    role: "explorer",
    description: "Read-only repo mapping and discovery. Cannot write, run shell, or complete tasks.",
    allowed_tools: READ_ONLY_TOOLS,
    forbidden_tools: [...WRITE_TOOLS, "advance_step"],
    can_write: false,
    can_run_commands: false,
    shell_risk_tolerance: "low-only",
    requires_approval: false,
  },

  /* 2) Architect — read-only planning. */
  architect: {
    role: "architect",
    description: "Designs the implementation approach. Read-only; cannot edit files or run commands.",
    allowed_tools: READ_ONLY_TOOLS,
    forbidden_tools: [...WRITE_TOOLS, "advance_step"],
    can_write: false,
    can_run_commands: false,
    shell_risk_tolerance: "low-only",
    requires_approval: false,
  },

  /* 3) Implementer — write + run + test. */
  implementer: {
    role: "implementer",
    description: "Applies code changes based on the approved plan. May write files and run medium-risk commands.",
    allowed_tools: [
      ...READ_ONLY_TOOLS,
      ...WRITE_TOOLS,
      ...SKILL_AUTHORING_TOOLS,
      ...EXTENSION_AUTHORING_TOOLS,
      ...HOOK_AUTHORING_TOOLS,
      "advance_step",
    ],
    forbidden_tools: ["computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press", "screenshot", "start_live_view", "stop_live_view", "request_human_approval", "is_human_intervening", "wait", "get_screen_size", "get_mouse_position", "browser_control", "approve_skill", "uninstall_skill", "enable_extension", "trust_extension", "uninstall_extension", "approve_hook", "update_hook", "uninstall_hook"],
    can_write: true,
    can_run_commands: true,
    shell_risk_tolerance: "medium", // high still requires approval
    requires_approval: false,
  },

  /* 4) Test — write tests + run. */
  test: {
    role: "test",
    description: "Writes and runs tests. Same authority as the implementer but no implementation edits outside test files.",
    allowed_tools: [
      ...READ_ONLY_TOOLS,
      ...WRITE_TOOLS,
      "test_skill",
      "validate_extension",
      "reload_skills",
      "reload_extensions",
      "reload_hooks",
      "list_hooks",
      "advance_step",
    ],
    forbidden_tools: ["computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press", "screenshot", "start_live_view", "stop_live_view", "request_human_approval", "is_human_intervening", "wait", "get_screen_size", "get_mouse_position", "browser_control", "create_skill", "approve_skill", "uninstall_skill", "create_extension", "enable_extension", "trust_extension", "uninstall_extension", "create_hook", "update_hook", "approve_hook", "uninstall_hook"],
    can_write: true,
    can_run_commands: true,
    shell_risk_tolerance: "medium",
    requires_approval: false,
  },

  /* 5) Reviewer — read-only diff review. */
  reviewer: {
    role: "reviewer",
    description: "Reviews the diff. Read-only; cannot edit files. May run read-only or test commands.",
    allowed_tools: [...READ_ONLY_TOOLS, "bash", "read_background_output"],
    forbidden_tools: ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "advance_step", "computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press", "screenshot", "start_live_view", "stop_live_view", "request_human_approval", "is_human_intervening", "wait", "get_screen_size", "get_mouse_position", "browser_control"],
    can_write: false,
    can_run_commands: true, // for tests / inspection
    shell_risk_tolerance: "medium",
    requires_approval: false,
  },

  /* 6) Critic — adversarial read-only. */
  critic: {
    role: "critic",
    description: "Adversarially challenges the solution. Strictly read-only.",
    allowed_tools: READ_ONLY_TOOLS,
    forbidden_tools: [...WRITE_TOOLS, "advance_step", "computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press", "screenshot", "start_live_view", "stop_live_view", "request_human_approval", "is_human_intervening", "wait", "get_screen_size", "get_mouse_position", "browser_control"],
    can_write: false,
    can_run_commands: false,
    shell_risk_tolerance: "low-only",
    requires_approval: false,
  },

  /* 7) Browser — web/browser-only task profile. */
  browser: {
    role: "browser",
    description: "Specialized for web tasks: web search, web fetch, browser_control, screen inspection. No file edits.",
    allowed_tools: [
      "read_file",
      "view_file",
      "list_directory",
      "grep_search",
      "skim_file",
      "inspect_environment",
      "web_search",
      "web_fetch",
      "search_tools",
      "get_tool_output",
      "browser_control",
      "screenshot",
      "get_screen_size",
      "get_mouse_position",
      "wait",
      "start_live_view",
      "stop_live_view",
      "request_human_approval",
      "is_human_intervening",
      "task_create",
      "task_update",
      "task_list",
      "activate_skill",
    ],
    forbidden_tools: ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file", "bash", "advance_step", "computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press", "read_background_output", "signal_process", "write_to_process"],
    can_write: false,
    can_run_commands: false,
    shell_risk_tolerance: "low-only",
    requires_approval: false,
  },

  /* 8) Root — the orchestrator itself. */
  root: {
    role: "root",
    description: "The orchestrator. May call every registered tool subject to per-tool risk handling.",
    allowed_tools: Object.keys(TOOL_METADATA),
    forbidden_tools: [], // per-tool forbidden_in_roles may still restrict; root defaults to "may call but may be blocked by risk gate"
    can_write: true,
    can_run_commands: true,
    shell_risk_tolerance: "high", // root is trusted, but high-risk still audited
    requires_approval: false,
  },
};

/* -------------------------------------------------------------------------- */
/*                                Lookup helpers                              */
/* -------------------------------------------------------------------------- */

export function getRoleProfile(role: string): RoleProfile | null {
  if (role in ROLE_PROFILES) return ROLE_PROFILES[role as PolicyRole];
  return null;
}

export function listRoleNames(): PolicyRole[] {
  return Object.keys(ROLE_PROFILES) as PolicyRole[];
}

/**
 * Returns true iff the role's profile permits the given tool. The
 * check is:
 *   1. Tool is not in `forbidden_tools` (hard deny).
 *   2. Tool is in `allowed_tools` (hard allow) OR the role is
 *      `root` (root's allowed_tools covers the whole registry).
 *
 * This intentionally does NOT consult `ToolMetadata.forbidden_in_roles` —
 * that list is layered in `policy-engine.ts` as a redundant check.
 */
export function roleAllowsTool(role: PolicyRole, toolName: string): boolean {
  const profile = ROLE_PROFILES[role];
  if (!profile) return false;
  if (profile.forbidden_tools.includes(toolName)) return false;
  if (profile.allowed_tools.includes(toolName)) return true;
  if (role === "root") return true;
  return false;
}

/**
 * Returns true iff the role may run a command at the given risk
 * level. `tolerance` is the role's ceiling.
 */
export function roleToleratesCommandRisk(role: PolicyRole, risk: RiskLevel): boolean {
  const profile = ROLE_PROFILES[role];
  if (!profile) return false;
  switch (profile.shell_risk_tolerance) {
    case "low-only":
      return risk === "low";
    case "medium":
      return risk === "low" || risk === "medium";
    case "high":
      return true; // root can do anything; per-tool approval still applies
  }
}

/**
 * Returns the set of tools the role profile says are writable.
 * Used by the preferred-ordering engine to flag "you wrote a file
 * without ever reading it" type sequences.
 */
export function getRoleWritableTools(role: PolicyRole): ReadonlySet<string> {
  return new Set(ROLE_PROFILES[role].allowed_tools.filter((t) => {
    const meta = getToolMetadata(t);
    return meta?.can_modify_files === true;
  }));
}
