/**
 * Static tool surface for the main coding agent.
 *
 * Extracted from runtime/engine.ts to keep the engine smaller.
 */

export interface AgentToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildGeneralAgentTools(): AgentToolDescriptor[] {
  // The main agent's tool surface is a curated, always-on set. It is large
  // enough to support general coding workflows (search, edit, verify, plan) but
  // small enough to keep prompt tokens bounded. The full tool registry stays
  // discoverable via search_tools when the model needs rare capabilities.
  return [
    {
      name: "file_view",
      description: "Primary file-reading tool. Open a stable numbered viewport into a workspace file. Use this before editing existing files so you can reference exact line numbers; prefer file_scroll for nearby context and file_find for within-file search instead of rereading whole files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "number", description: "1-based line to start at. Defaults to 1." },
          window: { type: "number", description: "Number of lines to show. Defaults to 80." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "file_scroll",
      description: "Move an existing file_view viewport up/down/to a line without rereading the whole file. Use after file_view when you need adjacent context.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path already viewed." },
          direction: { type: "string", enum: ["up", "down", "to"], description: "Scroll up/down or jump to a line." },
          lines: { type: "number", description: "Lines to move for up/down." },
          line: { type: "number", description: "Target 1-based line for direction=to." },
          window: { type: "number", description: "Optional new viewport size." },
        },
        required: ["path", "direction"],
        additionalProperties: false,
      },
    },
    {
      name: "file_find",
      description: "Search within one file and return matching line numbers plus snippets. Use after grep_search identifies a file, or instead of scanning a viewed file manually.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          pattern: { type: "string", description: "Plain text or regex pattern." },
          regex: { type: "boolean", description: "Treat pattern as regex when true." },
          case_sensitive: { type: "boolean" },
          max_results: { type: "number" },
          context: { type: "number", description: "Context lines around matches." },
        },
        required: ["path", "pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "grep_search",
      description: "Search for a regex pattern across workspace files. Returns matching lines with file paths and line numbers.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          maxResults: { type: "number" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "list_directory",
      description: "List entries under a workspace directory (non-recursive).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          includeHidden: { type: "boolean" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does, and automatically creates parent directories. Use write_file for new files and complete rewrites; for build tasks, many focused write_file calls are usually the fastest path to shipping the repository.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "file_edit",
      description: "Primary targeted editing tool for existing files. Replace a 1-based inclusive line range with new content, then run the pinned linter and automatically roll back if validation fails. Use after file_view/file_find gives exact line numbers. Prefer this over replace_in_file for existing-file edits.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "number", description: "1-based first line to replace." },
          end_line: { type: "number", description: "1-based last line to replace, inclusive." },
          new_content: { type: "string", description: "Replacement text for the selected line range." },
          reason: { type: "string", description: "Brief reason for the edit." },
        },
        required: ["path", "start_line", "end_line", "new_content"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_file",
      description: "Delete a workspace file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "bash",
      description: "Run a shell command in the workspace, usually for tests, verification, or repo introspection. Provide a concise `description` and explicit `timeout`/`timeoutMs`. Use `isBackground`/`run_in_background` for long-running servers. Outputs above 8KB are spillovered to .reaper/spillover; use get_tool_output to retrieve.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cmd: { type: "string" },
          description: { type: "string" },
          summary: { type: "string" },
          timeout: { type: "number" },
          timeoutMs: { type: "number" },
          run_in_background: { type: "boolean" },
          isBackground: { type: "boolean" },
        },
        additionalProperties: false,
        oneOf: [{ required: ["command"] }, { required: ["cmd"] }],
      },
    },
    {
      name: "git_status",
      description: "Inspect current git status (modified, added, deleted files).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "git_diff",
      description: "Show uncommitted changes. With staged:true shows staged diff, with path filter restricts to a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          staged: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "create_checkpoint",
      description: "Snapshot the current workspace into a checkpoint. Use before risky changes so you can restore if the change breaks things.",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "restore_checkpoint",
      description: "Restore the workspace to a previously created checkpoint.",
      inputSchema: {
        type: "object",
        properties: { checkpointId: { type: "string" } },
        required: ["checkpointId"],
        additionalProperties: false,
      },
    },
    {
      name: "web_search",
      description: "Search the web for a query. Use for documentation lookups, version-specific answers, and external references.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "call_subagent",
      description: "Delegate a focused, read-only investigation to a subagent (codebase exploration, doc lookup, dependency research). The subagent returns a structured result; you stay in control.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    {
      name: "search_tools",
      description: "Discover additional tools beyond the always-on set. Use when none of the always-on tools fit the next step (e.g. browser control, human approval, MCP tools).",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_tool_output",
      description: "Retrieve a previously spillovered tool result by artifact id. Use after run_shell_command returns a spillover handle. Supports startLine/endLine, regex pattern, jsonPath, and maxBytes to inspect large outputs without re-pasting.",
      inputSchema: {
        type: "object",
        properties: {
          artifactId: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          pattern: { type: "string" },
          jsonPath: { type: "string" },
          maxBytes: { type: "number" },
        },
        required: ["artifactId"],
        additionalProperties: false,
      },
    },
    {
      name: "complete_task",
      description: "Mark the task complete after implementation and verification evidence. Use this immediately after relevant tests/verification pass.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  ];
}
