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
  file_view: ["path", "start_line", "window"],
  file_scroll: ["path", "direction", "lines"],
  file_find: ["path", "pattern", "start_line"],
  file_edit: ["path", "start_line", "end_line", "new_content", "reason"],
  list_directory: ["path", "includeHidden"],
  grep_search: ["pattern", "path", "include"],
  skim_file: ["path", "goalHint"],
  inspect_environment: [],
  web_search: ["query", "engine", "maxResults", "scrapePages"],
  write_file: ["path", "content"],
  replace_in_file: ["path", "oldString", "newString", "allowMultiple", "startLine", "endLine", "content"],
  edit_file: ["path", "edits"],
  delete_file: ["path"],
  bash: ["cmd", "description", "timeout", "run_in_background"],
  read_background_output: ["pid", "lines", "waitForMatch", "minWaitMs"],
  signal_process: ["pid", "signal"],
  write_to_process: ["pid", "input"],
  activate_skill: ["name"],
  get_tool_output: ["artifactId"],
  web_fetch: ["url", "extractText"],
  diagnostics: ["path", "kind"],
};

export const KNOWN_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_ALLOWED_ARGS));

export function isKnownToolName(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

export function getAllowedArgs(toolName: string): readonly string[] {
  return TOOL_ALLOWED_ARGS[toolName] ?? [];
}
