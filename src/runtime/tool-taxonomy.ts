import { KNOWN_TOOLS } from "./tool-args.js";

export type ToolKind = "control" | "executable" | "unknown";

export const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "update_task_contract",
  "update_plan",
  "update_todo",
  "create_checkpoint",
  "restore_checkpoint",

  // Existing runtime control signals.
  "advance_step",
]);

export const REQUIRED_EXECUTABLE_TOOLS: ReadonlySet<string> = new Set([
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
  "bash",
  "run_test_command",
  "read_test_failure_summary",
]);

export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "update_task_contract",
  "create_checkpoint",
  "restore_checkpoint",
  "write_file",
  "replace_in_file",
  "edit_file",
  "apply_patch",
  "bash",

  // Existing runtime mutation surfaces.
  "delete_file",
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


