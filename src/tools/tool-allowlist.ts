/**
 * S8: single source of truth for the runtime tool allowlist.
 *
 * The runtime has two related allowlists: the set of valid tool
 * names (consumed by `isKnownToolName`) and the per-tool arg shape
 * (consumed by `stripUnknownToolArgs`). They were duplicated and
 * drifted (e.g. `view_file` was in the args list but missing from
 * the name set). This module unifies them.
 *
 * Adding a tool: append an entry to `TOOL_ALLOWED_ARGS` with the
 * tool's allowed top-level argument names. The set is auto-derived
 * via `KNOWN_TOOLS`.
 */

const TOOL_ALLOWED_ARGS: Record<string, readonly string[]> = {
  read_file: ["path", "startLine", "endLine"],
  view_file: ["path", "startLine", "endLine"],
  list_directory: ["path", "includeHidden"],
  grep_search: ["pattern", "path", "include"],
  skim_file: ["path", "goalHint"],
  inspect_environment: [],
  web_search: ["query", "engine", "maxResults", "scrapePages"],
  write_file: ["path", "content"],
  replace_in_file: ["path", "oldString", "newString", "allowMultiple", "startLine", "endLine", "content"],
  edit_file: ["path", "edits"],
  replace_symbol: ["path", "symbolName", "newCode"],
  delete_file: ["path"],
  run_shell_command: ["cmd", "summary", "barrier", "forceNonBarrier", "isBackground", "timeoutMs", "idleTimeoutMs"],
  read_background_output: ["pid", "lines", "waitForMatch", "minWaitMs"],
  signal_process: ["pid", "signal"],
  write_to_process: ["pid", "input"],
  activate_skill: ["name"],
  get_tool_output: ["artifactId"],
  advance_step: ["summary", "stepId", "evidence"],
  complete_task: ["summary", "verificationContract", "objectives"],
  web_fetch: ["url", "extractText"],
  task_create: ["subject", "description", "status"],
  task_update: ["taskId", "status", "subject", "description"],
  task_list: ["status"],
  update_plan: ["markdown", "activePlanMarkdown", "candidate"],
  update_todo: ["items", "append"],
  call_subagent: ["type", "task", "context", "mode", "allowedFiles", "forbiddenFiles", "timeoutMs", "outputSchema"],
  poll_subagent: ["jobId"],
  cancel_subagent: ["jobId", "reason"],
};

export const KNOWN_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_ALLOWED_ARGS));

export function isKnownToolName(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

export function getAllowedArgs(toolName: string): readonly string[] {
  return TOOL_ALLOWED_ARGS[toolName] ?? [];
}
