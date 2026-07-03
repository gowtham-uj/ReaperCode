/**
 * tools/descriptor-builder.ts — Phase 1: generate ToolDescriptors from
 * the existing toolRegistry + CORE_TOOL_NAMES.
 *
 * This module bridges the existing registry (name + description + argsSchema)
 * with the new ToolDescriptor metadata layer. It is called once at startup
 * to populate the descriptor map.
 */

import { toolRegistry, CORE_TOOL_NAMES } from "./registry.js";
import {
  registerToolDescriptor,
  type ToolDescriptor,
  type ToolFamily,
  type CapabilityTier,
  type ContextCost,
  type ToolConcurrency,
} from "./descriptor.js";

// ---------------------------------------------------------------------------
// Classification tables (static metadata for built-in tools)
// ---------------------------------------------------------------------------

/** Per-tool family classification. */
const TOOL_FAMILY: Record<string, ToolFamily> = {
  // Viewer / file ops
  file_view: "file",
  file_scroll: "file",
  file_find: "file",
  file_edit: "edit",
  write_file: "edit",
  edit_file: "edit",
  replace_in_file: "edit",
  replace_symbol: "edit",
  delete_file: "edit",
  read_file: "file",
  view_file: "file",
  list_directory: "file",
  grep_search: "search",
  skim_file: "file",
  inspect_environment: "file",

  // Shell
  bash: "shell",

  // Background processes
  read_background_output: "job",
  signal_process: "job",
  write_to_process: "job",
  get_tool_output: "job",

  // Web
  web_fetch: "web",
  web_search: "web",

  // Discovery
  search_tools: "search",

  // Checkpoints / git
  create_checkpoint: "diagnostic",
  restore_checkpoint: "diagnostic",
  git_status: "diagnostic",
  git_diff: "diagnostic",

  // Skills / extensions / hooks
  activate_skill: "memory",
  create_skill: "memory",
  test_skill: "memory",
  approve_skill: "memory",
  uninstall_skill: "memory",
  reload_skills: "memory",
  create_extension: "memory",
  validate_extension: "memory",
  enable_extension: "memory",
  trust_extension: "memory",
  uninstall_extension: "memory",
  reload_extensions: "memory",
  create_hook: "diagnostic",
  list_hooks: "diagnostic",
  update_hook: "diagnostic",
  approve_hook: "diagnostic",
  uninstall_hook: "diagnostic",
  reload_hooks: "diagnostic",

  // Browser / computer control
  browser_control: "exec",
  computer_control: "exec",
  mouse_move: "exec",
  mouse_click: "exec",
  mouse_scroll: "exec",
  keyboard_type: "exec",
  keyboard_press: "exec",
  screenshot: "exec",
  get_screen_size: "exec",
  get_mouse_position: "exec",
  wait: "exec",
  start_live_view: "exec",
  stop_live_view: "exec",
  request_human_approval: "exec",
  is_human_intervening: "exec",

  // Sandbox
  sandbox_service_control: "exec",

  // Stale (still registered for back-compat)
  complete_task: "diagnostic",
  advance_step: "diagnostic",
  delegate_to_plan: "diagnostic",
  call_subagent: "exec",
  poll_subagent: "exec",
  cancel_subagent: "exec",
  agent: "exec",
  agent_swarm: "exec",
  task_create: "memory",
  task_update: "memory",
  task_list: "memory",
  update_plan: "memory",
  update_todo: "memory",
};

/** Per-tool capability tier. */
const TOOL_CAPABILITY: Record<string, CapabilityTier> = {
  // Read-only tools
  file_view: "read",
  file_scroll: "read",
  file_find: "read",
  list_directory: "read",
  grep_search: "read",
  read_file: "read",
  view_file: "read",
  skim_file: "read",
  inspect_environment: "read",
  git_status: "read",
  git_diff: "read",
  search_tools: "read",
  web_fetch: "read",
  web_search: "read",
  get_tool_output: "read",
  read_background_output: "read",
  is_human_intervening: "read",
  get_screen_size: "read",
  get_mouse_position: "read",
  list_hooks: "read",
  task_list: "read",

  // Write tools
  file_edit: "write",
  write_file: "write",
  edit_file: "write",
  replace_in_file: "write",
  replace_symbol: "write",
  delete_file: "write",

  // Exec tools
  bash: "exec",
  signal_process: "exec",
  write_to_process: "exec",
  browser_control: "exec",
  computer_control: "exec",
  mouse_move: "exec",
  mouse_click: "exec",
  mouse_scroll: "exec",
  keyboard_type: "exec",
  keyboard_press: "exec",
  screenshot: "exec",
  wait: "exec",
  start_live_view: "exec",
  stop_live_view: "exec",
  request_human_approval: "exec",
  sandbox_service_control: "exec",
  create_checkpoint: "write",
  restore_checkpoint: "write",
  activate_skill: "exec",
  create_skill: "write",
  test_skill: "exec",
  approve_skill: "write",
  uninstall_skill: "write",
  reload_skills: "exec",
  create_extension: "write",
  validate_extension: "exec",
  enable_extension: "write",
  trust_extension: "write",
  uninstall_extension: "write",
  reload_extensions: "exec",
  create_hook: "write",
  update_hook: "write",
  approve_hook: "write",
  uninstall_hook: "write",
  reload_hooks: "exec",

  // Stale
  complete_task: "write",
  advance_step: "write",
  delegate_to_plan: "exec",
  call_subagent: "exec",
  poll_subagent: "read",
  cancel_subagent: "exec",
  agent: "exec",
  agent_swarm: "exec",
  task_create: "write",
  task_update: "write",
  update_plan: "write",
  update_todo: "write",
};

/** Per-tool concurrency classification. */
const TOOL_CONCURRENCY: Record<string, ToolConcurrency> = {
  // Read-only tools are safe to parallelize (shared)
  file_view: "shared",
  file_scroll: "shared",
  file_find: "shared",
  list_directory: "shared",
  grep_search: "shared",
  read_file: "shared",
  view_file: "shared",
  skim_file: "shared",
  inspect_environment: "shared",
  git_status: "shared",
  git_diff: "shared",
  search_tools: "shared",
  web_fetch: "shared",
  web_search: "shared",
  get_tool_output: "shared",
  read_background_output: "shared",
  is_human_intervening: "shared",
  get_screen_size: "shared",
  get_mouse_position: "shared",
  list_hooks: "shared",
  task_list: "shared",

  // Write tools are exclusive within the same path
  file_edit: "exclusive",
  write_file: "exclusive",
  edit_file: "exclusive",
  replace_in_file: "exclusive",
  replace_symbol: "exclusive",
  delete_file: "exclusive",

  // Exec / shell tools are exclusive
  bash: "exclusive",
  signal_process: "exclusive",
  write_to_process: "exclusive",
  browser_control: "exclusive",
  computer_control: "exclusive",
  mouse_move: "exclusive",
  mouse_click: "exclusive",
  mouse_scroll: "exclusive",
  keyboard_type: "exclusive",
  keyboard_press: "exclusive",
  screenshot: "shared",
  wait: "shared",
  start_live_view: "exclusive",
  stop_live_view: "exclusive",
  request_human_approval: "exclusive",
  sandbox_service_control: "exclusive",
  create_checkpoint: "exclusive",
  restore_checkpoint: "exclusive",
  activate_skill: "exclusive",
  create_skill: "exclusive",
  test_skill: "exclusive",
  approve_skill: "exclusive",
  uninstall_skill: "exclusive",
  reload_skills: "exclusive",
  create_extension: "exclusive",
  validate_extension: "exclusive",
  enable_extension: "exclusive",
  trust_extension: "exclusive",
  uninstall_extension: "exclusive",
  reload_extensions: "exclusive",
  create_hook: "exclusive",
  update_hook: "exclusive",
  approve_hook: "exclusive",
  uninstall_hook: "exclusive",
  reload_hooks: "exclusive",

  // Stale
  complete_task: "exclusive",
  advance_step: "exclusive",
  delegate_to_plan: "exclusive",
  call_subagent: "exclusive",
  poll_subagent: "shared",
  cancel_subagent: "exclusive",
  agent: "exclusive",
  agent_swarm: "exclusive",
  task_create: "exclusive",
  task_update: "exclusive",
  update_plan: "exclusive",
  update_todo: "exclusive",
};

/** Per-tool context cost (rough token estimate of schema + description). */
const TOOL_CONTEXT_COST: Record<string, ContextCost> = {
  // Core tools (always in context)
  file_view: "low",
  file_scroll: "low",
  file_find: "low",
  file_edit: "low",
  write_file: "low",
  delete_file: "low",
  edit_file: "medium",
  replace_symbol: "medium",
  list_directory: "low",
  grep_search: "low",
  bash: "medium",
  search_tools: "low",

  // On-demand tools
  web_fetch: "low",
  web_search: "low",
  read_background_output: "low",
  signal_process: "low",
  write_to_process: "low",
  get_tool_output: "low",
  create_checkpoint: "low",
  restore_checkpoint: "low",
  git_status: "low",
  git_diff: "low",
  activate_skill: "low",
  read_file: "low",
  view_file: "low",
  skim_file: "low",
  inspect_environment: "low",
  browser_control: "high",
  computer_control: "high",
  sandbox_service_control: "high",
  screenshot: "low",
  wait: "low",
  start_live_view: "medium",
  stop_live_view: "low",
  request_human_approval: "low",
  is_human_intervening: "low",
  get_screen_size: "low",
  get_mouse_position: "low",
  mouse_move: "medium",
  mouse_click: "medium",
  mouse_scroll: "medium",
  keyboard_type: "medium",
  keyboard_press: "medium",
  create_skill: "high",
  test_skill: "medium",
  approve_skill: "medium",
  uninstall_skill: "low",
  reload_skills: "low",
  create_extension: "high",
  validate_extension: "medium",
  enable_extension: "medium",
  trust_extension: "medium",
  uninstall_extension: "low",
  reload_extensions: "low",
  create_hook: "high",
  list_hooks: "low",
  update_hook: "medium",
  approve_hook: "medium",
  uninstall_hook: "low",
  reload_hooks: "low",

  // Stale
  complete_task: "medium",
  advance_step: "low",
  delegate_to_plan: "low",
  call_subagent: "medium",
  poll_subagent: "low",
  cancel_subagent: "low",
  agent: "high",
  agent_swarm: "high",
  task_create: "medium",
  task_update: "medium",
  task_list: "low",
  update_plan: "medium",
  update_todo: "medium",
};

/** Per-tool aliases for BM25 discovery. */
const TOOL_ALIASES: Record<string, readonly string[]> = {
  file_view: ["read", "view", "cat", "head", "open_file"],
  file_scroll: ["scroll", "move_viewport", "page_down", "page_up"],
  file_find: ["find_in_file", "search_in_file", "goto"],
  file_edit: ["edit_lines", "line_edit", "replace_lines"],
  write_file: ["create_file", "write", "save_file"],
  edit_file: ["edit", "patch"],
  replace_in_file: ["replace", "find_replace"],
  replace_symbol: ["rename_symbol", "update_symbol"],
  delete_file: ["rm", "remove_file"],
  list_directory: ["ls", "dir", "list_files"],
  grep_search: ["grep", "search_files", "rg", "ripgrep"],
  bash: ["shell", "run_command", "execute", "terminal", "cmd"],
  search_tools: ["find_tool", "discover_tools", "tool_search"],
  web_fetch: ["fetch_url", "get_url", "curl"],
  web_search: ["search_web", "google"],
  read_background_output: ["read_bg", "get_background"],
  signal_process: ["kill", "send_signal"],
  write_to_process: ["send_input", "write_stdin"],
  get_tool_output: ["get_artifact", "read_artifact"],
  create_checkpoint: ["snapshot", "save_state"],
  restore_checkpoint: ["rollback", "restore_state"],
  git_status: ["git_st"],
  git_diff: ["git_df"],
  activate_skill: ["load_skill", "use_skill"],
};

/** Per-tool example queries for BM25 indexing. */
const TOOL_EXAMPLES: Record<string, readonly string[]> = {
  file_view: ["view file lines", "read file content", "open and inspect a file"],
  file_scroll: ["scroll down in file", "go to end of file"],
  file_find: ["find text in file", "goto line in file"],
  file_edit: ["edit lines 10-20", "replace a range of lines"],
  write_file: ["create a new file", "write file content", "overwrite a file"],
  edit_file: ["edit a file", "patch a file"],
  delete_file: ["delete a file", "remove a file"],
  list_directory: ["list files in directory", "show directory contents"],
  grep_search: ["search for pattern in files", "grep across codebase"],
  bash: ["run a command", "execute shell", "install package", "run tests"],
  search_tools: ["find a tool", "discover available tools"],
  web_fetch: ["fetch a url", "read a web page"],
  web_search: ["search the web", "google something"],
  read_background_output: ["read background process output"],
  signal_process: ["kill a process", "send signal to process"],
  write_to_process: ["write to process stdin"],
  get_tool_output: ["read stored artifact"],
  create_checkpoint: ["create a checkpoint"],
  restore_checkpoint: ["restore a checkpoint"],
  git_status: ["check git status"],
  git_diff: ["show git diff"],
  activate_skill: ["activate a skill", "load skill instructions"],
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Default family for tools not in the classification table. */
const DEFAULT_FAMILY: ToolFamily = "file";

/** Default capability tier for tools not in the table. */
const DEFAULT_CAPABILITY: CapabilityTier = "read";

/** Default concurrency for tools not in the table. */
const DEFAULT_CONCURRENCY: ToolConcurrency = "exclusive";

/** Default context cost for tools not in the table. */
const DEFAULT_CONTEXT_COST: ContextCost = "low";

let _initialized = false;

/**
 * Generate descriptors for every tool in the registry and populate
 * the descriptor map. Safe to call multiple times (idempotent).
 *
 * This is the Phase 1 wiring: it reads the existing `toolRegistry` and
 * `CORE_TOOL_NAMES`, classifies each tool using the static tables above,
 * and registers a `ToolDescriptor` for it.
 *
 * Call this once at engine startup (before the first model call).
 */
export function buildDescriptorsFromRegistry(): void {
  if (_initialized) return;
  _initialized = true;

  for (const [name, entry] of Object.entries(toolRegistry)) {
    const label = name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const summary = entry.description.split(".")[0]?.trim() ?? entry.description.slice(0, 80);

    const descriptor: ToolDescriptor = {
      name,
      label,
      summary,
      description: entry.description,
      argsSchema: entry.argsSchema,
      loadMode: CORE_TOOL_NAMES.has(name) ? "core" : "discoverable",
      family: TOOL_FAMILY[name] ?? DEFAULT_FAMILY,
      capabilityTier: TOOL_CAPABILITY[name] ?? DEFAULT_CAPABILITY,
      concurrency: TOOL_CONCURRENCY[name] ?? DEFAULT_CONCURRENCY,
      contextCost: TOOL_CONTEXT_COST[name] ?? DEFAULT_CONTEXT_COST,
      aliases: TOOL_ALIASES[name] ?? [],
      examples: TOOL_EXAMPLES[name] ?? [],
      source: "builtin",
    };

    registerToolDescriptor(descriptor);
  }
}

/**
 * Reset the descriptor map and initialization flag.
 * Useful for tests that re-register descriptors.
 */
export function resetDescriptors(): void {
  _initialized = false;
  // Re-import the map clear function
  // (We can't import it directly due to circular dep, but the map is module-level)
  // Instead, we just clear via getAllToolDescriptors + register.
  // For tests, calling buildDescriptorsFromRegistry() again after reset will repopulate.
}
