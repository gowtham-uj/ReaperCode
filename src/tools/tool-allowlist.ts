/**
 * S8: single source of truth for the runtime tool allowlist.
 *
 * The runtime has two related allowlists: the set of valid tool
 * names (consumed by `isKnownToolName`) and the per-tool arg shape
 * (consumed by `stripUnknownToolArgs`). They were duplicated and
 * drifted (e.g. a viewer name was in the args list but missing from
 * the name set). This module unifies them.
 *
 * Adding a tool: append an entry to `TOOL_ALLOWED_ARGS` with the
 * tool's allowed top-level argument names. The set is auto-derived
 * via `KNOWN_TOOLS`.
 */

const TOOL_ALLOWED_ARGS: Record<string, readonly string[]> = {
  file_view: ["path", "start_line", "window"],
  file_find: ["path", "pattern", "start_line"],
  file_edit: ["path", "start_line", "end_line", "new_content", "reason"],
  list_directory: ["path", "includeHidden"],
  grep_search: ["pattern", "path", "include"],
  skim_file: ["path", "goalHint"],
  inspect_environment: [],
  web_search: ["query", "engine", "maxResults", "scrapePages"],
  write_file: ["path", "content"],
  edit_file: ["path", "edits"],
  delete_file: ["path"],
  bash: ["cmd", "description", "timeout", "run_in_background"],
  /*
   * Code Mode. One argument, and it is the whole of what a model sends: every
   * inner call the script makes is authorized separately, through the same
   * executor an ordinary call goes through — so there is nothing here to
   * enumerate beyond the source itself.
   */
  eval: ["code"],
  activate_skill: ["name"],
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
