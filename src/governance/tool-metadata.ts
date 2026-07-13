/**
 * Tool metadata: the per-tool classification layer that powers the
 * ToolPolicy system.
 *
 * The existing `src/tools/registry.ts` describes every tool's API
 * (description + argument schema). The metadata in this file adds the
 * *governance* view: how dangerous is this tool, what category of
 * work does it belong to, who is allowed to call it, and what tools
 * should it be sequenced with.
 *
 * Three things this module is NOT:
 *   - It is not a re-implementation of `src/policy/classifier.ts`.
 *     The classifier produces a binary `safe | dangerous |
 *     needs_confirmation` outcome for a tool call. The metadata here
 *     is the *static, structural* classification; the classifier is
 *     the *dynamic, instance-level* one.
 *   - It is not a replacement for `src/tools/tool-allowlist.ts`. The
 *     allowlist gates unknown tool names and unknown argument keys;
 *     this module gates *known* tools by role, risk, and ordering.
 *   - It is not hard-coded to a specific ecosystem. Tool names
 *     come from `src/tools/registry.ts`; categories and risk
 *     levels are based on observable tool behavior, not on
 *     language or project.
 *
 * Categories are intentionally coarse. The risk ladder is:
 *   - "low"      read-only, no host side effects
 *   - "medium"   local mutation, can be undone from the trajectory
 *   - "high"     external side effect (network, process, browser)
 *   - "critical" irreversible or auth-bearing action
 */

import { KNOWN_TOOLS } from "../tools/tool-allowlist.js";

/* -------------------------------------------------------------------------- */
/*                                Type surface                               */
/* -------------------------------------------------------------------------- */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ToolCategory =
  | "read"
  | "search"
  | "write"
  | "shell"
  | "service"
  | "browser"
  | "computer"
  | "process"
  | "human"
  | "skill"
  | "plan"
  | "task"
  | "control"
  | "discovery";

export type PolicyRole =
  | "explorer"
  | "architect"
  | "implementer"
  | "test"
  | "reviewer"
  | "critic"
  | "browser"
  | "root";

export interface ToolMetadata {
  /** Tool name as registered in src/tools/registry.ts. */
  name: string;
  /** Coarse category for grouping and ordering. */
  category: ToolCategory;
  /** Static risk level. */
  risk_level: RiskLevel;
  /** True iff the tool never modifies persistent state. */
  is_read_only: boolean;
  /** True iff the tool can change files inside the workspace. */
  can_modify_files: boolean;
  /** True iff the tool can run arbitrary code or commands. */
  can_execute_code: boolean;
  /** True iff the tool can drive a graphical user interface. */
  can_control_ui: boolean;
  /** True iff the tool can affect the host OS, not just the workspace. */
  can_affect_host: boolean;
  /**
   * True iff the tool *must* require explicit human or supervisor
   * approval before execution, even when the caller is otherwise
   * permitted. This is the per-tool override that lives above
   * role-based permissions — for tools that should never auto-run.
   */
  requires_approval: boolean;
  /**
   * Tools the model should prefer to call *before* this one. The
   * policy engine emits an advisory note (not a hard block) when
   * the inverse sequence is detected, e.g. "you wrote a file
   * without reading it first".
   */
  preferred_before: string[];
  /**
   * Tools the model should prefer to call *after* this one. The
   * symmetric inverse of preferred_before.
   */
  preferred_after: string[];
  /**
   * Roles for which this tool is structurally forbidden. An entry
   * here ALWAYS denies, even if the role's allowlist would permit.
   */
  forbidden_in_roles: readonly PolicyRole[];
  /**
   * Roles for which this tool is explicitly required / preferred
   * (used by the preferred-ordering engine to suggest role-aware
   * tool sets). An empty list means "no role-specific preference".
   */
  allowed_in_roles: readonly PolicyRole[];
}

/* -------------------------------------------------------------------------- */
/*                              Governance roles                              */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                              The metadata map                              */
/* -------------------------------------------------------------------------- */

export const TOOL_METADATA: Record<string, ToolMetadata> = {
  // ---- Read ----
  read_file: {
    name: "read_file",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "edit_file", "replace_in_file", "delete_file", "bash"],
    preferred_after: ["grep_search", "skim_file"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  view_file: {
    name: "view_file",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "edit_file", "replace_in_file", "delete_file", "bash"],
    preferred_after: ["grep_search", "skim_file"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  file_view: {
    name: "file_view",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "file_edit", "delete_file", "bash"],
    preferred_after: ["file_find", "grep_search"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  file_scroll: {
    name: "file_scroll",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "file_edit", "delete_file", "bash"],
    preferred_after: ["file_find", "grep_search"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  list_directory: {
    name: "list_directory",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  skim_file: {
    name: "skim_file",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "root"],
  },
  inspect_environment: {
    name: "inspect_environment",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["bash", "write_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },

  // ---- Search / discovery ----
  grep_search: {
    name: "grep_search",
    category: "search",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file", "write_file", "edit_file", "replace_in_file"],
    preferred_after: ["list_directory"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  file_find: {
    name: "file_find",
    category: "search",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "file_edit", "write_file"],
    preferred_after: ["list_directory"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  web_search: {
    name: "web_search",
    category: "search",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true, // egress
    requires_approval: false,
    preferred_before: [],
    preferred_after: ["web_fetch"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  web_fetch: {
    name: "web_fetch",
    category: "search",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true, // egress
    requires_approval: false,
    preferred_before: ["web_search"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  search_tools: {
    name: "search_tools",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },

  // ---- Write ----
  write_file: {
    name: "write_file",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file", "inspect_environment", "grep_search"],
    preferred_after: ["bash"], // for typecheck / build
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  replace_in_file: {
    name: "replace_in_file",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file", "grep_search"],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  edit_file: {
    name: "edit_file",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file", "grep_search"],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  file_edit: {
    name: "file_edit",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "file_find", "grep_search"],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  replace_symbol: {
    name: "replace_symbol",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file"],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  delete_file: {
    name: "delete_file",
    category: "write",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["read_file", "view_file"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Shell ----
  bash: {
    name: "bash",
    category: "shell",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: true,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false, // approval is driven by classifyCommandRisk
    preferred_before: ["read_file", "view_file", "inspect_environment", "grep_search"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Browser ----
  browser_control: {
    name: "browser_control",
    category: "browser",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["web_search", "web_fetch"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "root"],
    allowed_in_roles: ["browser"],
  },

  // ---- Native computer control ----
  // Root is allowed (with requires_approval) so the
  // policy engine can route to the human-approval tool.
  // Subagents are structurally forbidden.
  computer_control: {
    name: "computer_control",
    category: "computer",
    risk_level: "critical",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: true, // native OS control
    preferred_before: ["browser_control"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  mouse_move: {
    name: "mouse_move",
    category: "computer",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: true,
    preferred_before: ["screenshot", "get_screen_size"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  mouse_click: {
    name: "mouse_click",
    category: "computer",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: true,
    preferred_before: ["screenshot", "get_screen_size", "mouse_move"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  mouse_scroll: {
    name: "mouse_scroll",
    category: "computer",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: true,
    preferred_before: ["screenshot", "get_screen_size"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  keyboard_type: {
    name: "keyboard_type",
    category: "computer",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: true,
    preferred_before: ["screenshot", "mouse_click"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  keyboard_press: {
    name: "keyboard_press",
    category: "computer",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: true,
    preferred_before: ["screenshot"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  screenshot: {
    name: "screenshot",
    category: "computer",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["mouse_click", "mouse_move", "keyboard_type", "keyboard_press"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  get_screen_size: {
    name: "get_screen_size",
    category: "computer",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["mouse_move", "mouse_click", "mouse_scroll"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  get_mouse_position: {
    name: "get_mouse_position",
    category: "computer",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["mouse_click"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  wait: {
    name: "wait",
    category: "computer",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  start_live_view: {
    name: "start_live_view",
    category: "computer",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["screenshot"],
    preferred_after: ["stop_live_view"],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  stop_live_view: {
    name: "stop_live_view",
    category: "computer",
    risk_level: "low",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  request_human_approval: {
    name: "request_human_approval",
    category: "human",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },
  is_human_intervening: {
    name: "is_human_intervening",
    category: "human",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["browser", "root"],
  },

  // ---- Process ----
  read_background_output: {
    name: "read_background_output",
    category: "process",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  signal_process: {
    name: "signal_process",
    category: "process",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["read_background_output"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  write_to_process: {
    name: "write_to_process",
    category: "process",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["read_background_output"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Skills / artifacts ----
  activate_skill: {
    name: "activate_skill",
    category: "skill",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  get_tool_output: {
    name: "get_tool_output",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },

  // ---- Plan / task control ----
  advance_step: {
    name: "advance_step",
    category: "plan",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["bash", "write_file", "edit_file", "replace_in_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root"],
  },
  delegate_to_plan: {
    name: "delegate_to_plan",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["root"],
  },
  task_create: {
    name: "task_create",
    category: "task",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: ["task_update", "task_list"],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "architect", "implementer", "test", "reviewer", "critic", "explorer", "browser"],
  },
  task_update: {
    name: "task_update",
    category: "task",
    risk_level: "low",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["task_create"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "architect", "implementer", "test", "reviewer", "critic", "explorer", "browser"],
  },
  task_list: {
    name: "task_list",
    category: "task",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "architect", "implementer", "test", "reviewer", "critic", "explorer", "browser"],
  },


  update_plan: {
    name: "update_plan",
    category: "plan",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "explorer", "architect", "implementer", "test", "reviewer", "critic"],
  },
  update_todo: {
    name: "update_todo",
    category: "task",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "explorer", "architect", "implementer", "test", "reviewer", "critic"],
  },

  // ---- Authoring: Skills (5) ----
  create_skill: {
    name: "create_skill",
    category: "skill",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true, // writes <scope>/.reaper/skills/<name>/
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false, // lands as draft; activate_skill is the gated step
    preferred_before: ["activate_skill"],
    preferred_after: ["test_skill", "approve_skill"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "test", "browser"],
    allowed_in_roles: ["implementer", "root"],
  },
  test_skill: {
    name: "test_skill",
    category: "skill",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // runs manifest.validation.commands
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["approve_skill"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  approve_skill: {
    name: "approve_skill",
    category: "skill",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // promotes draft → user-trusted
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated by request_human_approval
    preferred_before: ["create_skill", "test_skill"],
    preferred_after: ["activate_skill"],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  uninstall_skill: {
    name: "uninstall_skill",
    category: "skill",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // removes skill folder + memory index
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  reload_skills: {
    name: "reload_skills",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: ["activate_skill"],
    forbidden_in_roles: [],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Authoring: Extensions (6, JS only) ----
  create_extension: {
    name: "create_extension",
    category: "write",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // writes extension.json + main.js to disk
    can_execute_code: false, // compile happens later, on trust_
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false, // lands dormant + project-untrusted
    preferred_before: ["validate_extension", "trust_extension"],
    preferred_after: ["enable_extension"],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "root"],
  },
  validate_extension: {
    name: "validate_extension",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // runs validation.commands
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["trust_extension"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  enable_extension: {
    name: "enable_extension",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // calls default.activate(ctx) — runs extension code
    can_control_ui: false,
    can_affect_host: true, // extension may register tools that touch the host
    requires_approval: true, // gated — extension must be user-trusted first
    preferred_before: ["trust_extension"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  trust_extension: {
    name: "trust_extension",
    category: "control",
    risk_level: "critical",
    is_read_only: false,
    can_modify_files: false, // trust lives in the in-memory registry
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true, // trust change can authorize future code execution
    requires_approval: true, // gated by request_human_approval — user must see the source
    preferred_before: ["create_extension", "validate_extension"],
    preferred_after: ["enable_extension"],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  uninstall_extension: {
    name: "uninstall_extension",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // removes extension folder + registry entries
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  reload_extensions: {
    name: "reload_extensions",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Authoring: Hooks (6, JS handlers, observe-only by default) ----
  create_hook: {
    name: "create_hook",
    category: "control",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true, // writes <scope>/.reaper/hooks/<id>.json
    can_execute_code: false, // compile happens on approve
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false, // lands as draft
    preferred_before: ["approve_hook"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "root"],
  },
  list_hooks: {
    name: "list_hooks",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  update_hook: {
    name: "update_hook",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // re-writes the hook JSON
    can_execute_code: false, // compile happens during the call
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // re-gated if enforce flips false → true
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  approve_hook: {
    name: "approve_hook",
    category: "control",
    risk_level: "critical",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // compiles and registers a live handler
    can_control_ui: false,
    can_affect_host: true, // an enforce:true hook can block tool calls system-wide
    requires_approval: true, // gated by request_human_approval — user must see the JS source
    preferred_before: ["create_hook"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  uninstall_hook: {
    name: "uninstall_hook",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // removes hook JSON + unregisters from runner
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  reload_hooks: {
    name: "reload_hooks",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["implementer", "test", "root"],
  },
};

/* -------------------------------------------------------------------------- */
/*                                 Helpers                                    */
/* -------------------------------------------------------------------------- */

export function getToolMetadata(name: string): ToolMetadata | null {
  return TOOL_METADATA[name] ?? null;
}

export function hasToolMetadata(name: string): boolean {
  return name in TOOL_METADATA;
}

/**
 * True iff every tool in `src/tools/tool-allowlist.ts` is also
 * classified here. This is the "no orphan tool" invariant that
 * prevents the policy engine from silently allowing a new tool
 * added to the registry without metadata. Drift here is a bug.
 */
export function assertMetadataCoversRegistry(): {
  ok: boolean;
  missing: string[];
  extras: string[];
} {
  const missing: string[] = [];
  for (const name of KNOWN_TOOLS) {
    if (!hasToolMetadata(name)) missing.push(name);
  }
  // Extras: tools that have metadata but were removed from the
  // registry. We allow these silently (they cost nothing and may
  // be referenced by tests), but we surface them so callers can
  // clean up.
  const extras: string[] = [];
  for (const name of Object.keys(TOOL_METADATA)) {
    if (!KNOWN_TOOLS.has(name)) extras.push(name);
  }
  return { ok: missing.length === 0, missing, extras };
}

