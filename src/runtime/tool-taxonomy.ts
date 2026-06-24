import { KNOWN_TOOLS } from "./tool-args.js";

export type ToolKind = "control" | "executable" | "unknown";

export const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "update_task_contract",
  "update_plan",
  "update_todo",
  "call_subagent",
  "poll_subagent",
  "cancel_subagent",
  "complete_task",
  "create_checkpoint",
  "restore_checkpoint",

  // Existing runtime control signals.
  "advance_step",
  "request_patch",
  "delegate_to_plan",
]);

export const REQUIRED_EXECUTABLE_TOOLS: ReadonlySet<string> = new Set([
  "inspect_project",
  "git_status",
  "git_diff",
  "read_file",
  "grep_search",
  "search_symbols",
  "list_package_scripts",
  "write_file",
  "replace_in_file",
  "edit_file",
  "apply_patch",
  "run_shell_command",
  "run_test_command",
  "read_test_failure_summary",
]);

export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "update_task_contract",
  "update_plan",
  "update_todo",
  "call_subagent",
  "cancel_subagent",
  "create_checkpoint",
  "restore_checkpoint",
  "write_file",
  "replace_in_file",
  "edit_file",
  "apply_patch",
  "run_shell_command",

  // Existing runtime mutation surfaces.
  "replace_symbol",
  "delete_file",
  "sandbox_service_control",
  "browser_control",
  "computer_control",
  "mouse_move",
  "mouse_click",
  "mouse_scroll",
  "keyboard_type",
  "keyboard_press",
  "start_live_view",
  "stop_live_view",
  "signal_process",
  "write_to_process",
  "task_create",
  "task_update",
  "agent",
  "agent_swarm",
  "create_skill",
  "test_skill",
  "approve_skill",
  "uninstall_skill",
  "reload_skills",
  "create_extension",
  "validate_extension",
  "enable_extension",
  "trust_extension",
  "uninstall_extension",
  "reload_extensions",
  "create_hook",
  "update_hook",
  "approve_hook",
  "uninstall_hook",
  "reload_hooks",
]);

export const COMPLETION_TOOLS: ReadonlySet<string> = new Set(["complete_task"]);

export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "call_subagent",
  "poll_subagent",
  "cancel_subagent",
  "agent",
  "agent_swarm",
]);

export function getToolKind(name: string): ToolKind {
  if (CONTROL_TOOLS.has(name)) return "control";
  if (REQUIRED_EXECUTABLE_TOOLS.has(name) || KNOWN_TOOLS.has(name)) return "executable";
  return "unknown";
}

export function isControlTool(name: string): boolean {
  return getToolKind(name) === "control";
}

export function isExecutableTool(name: string): boolean {
  return getToolKind(name) === "executable";
}

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

export function isCompletionTool(name: string): boolean {
  return COMPLETION_TOOLS.has(name);
}

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name);
}
