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
      name: "read_file",
      description: "Read a text file from the workspace by relative path. Returns the file contents (or a window).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
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
      name: "replace_in_file",
      description: "Replace an exact string in a workspace file. Use for targeted edits; prefer this over write_file when possible.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldString", "newString"],
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
