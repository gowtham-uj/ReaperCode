import {
  CompleteTaskArgsSchema,
  AdvanceStepArgsSchema,
  RequestPatchArgsSchema,
  DelegateToPlanArgsSchema,
  DeleteFileArgsSchema,
  GetToolOutputArgsSchema,
  GrepSearchArgsSchema,
  ListDirectoryArgsSchema,
  ReadBackgroundOutputArgsSchema,
  SignalProcessArgsSchema,
  WriteToProcessArgsSchema,
  ReadFileArgsSchema,
  ViewFileArgsSchema,
  SkimFileArgsSchema,
  InspectEnvironmentArgsSchema,
  CreateCheckpointArgsSchema,
  RestoreCheckpointArgsSchema,
  GitStatusArgsSchema,
  GitDiffArgsSchema,
  WebSearchArgsSchema,
  ReplaceInFileArgsSchema,
  EditFileArgsSchema,
  ReplaceSymbolArgsSchema,
  RunShellCommandArgsSchema,
  SandboxServiceControlArgsSchema,
  BrowserControlArgsSchema,
  ComputerControlArgsSchema,
  MouseMoveArgsSchema,
  MouseClickArgsSchema,
  MouseScrollArgsSchema,
  KeyboardTypeArgsSchema,
  KeyboardPressArgsSchema,
  ScreenshotArgsSchema,
  EmptyArgsSchema,
  WaitArgsSchema,
  StartLiveViewArgsSchema,
  RequestHumanApprovalArgsSchema,
  WriteFileArgsSchema,
  ActivateSkillArgsSchema,
  WebFetchArgsSchema,
  TaskCreateArgsSchema,
  TaskUpdateArgsSchema,
  TaskListArgsSchema,
  SearchToolsArgsSchema,
} from "./types.js";
import { AgentArgsSchema } from "./agent.types.js";
import { AgentSwarmArgsSchema } from "./agent-swarm.types.js";
import {
  CreateSkillArgsSchema,
  TestSkillArgsSchema,
  ApproveSkillArgsSchema,
  UninstallSkillArgsSchema,
  ReloadSkillsArgsSchema,
} from "./types/skill-tools.schema.js";
import {
  CreateExtensionArgsSchema,
  ValidateExtensionArgsSchema,
  EnableExtensionArgsSchema,
  TrustExtensionArgsSchema,
  UninstallExtensionArgsSchema,
  ReloadExtensionsArgsSchema,
} from "./types/extension-tools.schema.js";
import {
  CreateHookArgsSchema,
  ListHooksArgsSchema,
  UpdateHookArgsSchema,
  ApproveHookArgsSchema,
  UninstallHookArgsSchema,
  ReloadHooksArgsSchema,
} from "./types/hook-tools.schema.js";

export const toolRegistry = {
  read_file: {
    description:
      "Read file content. For large files, unbounded reads return only a preview; use startLine/endLine, grep_search, or skim_file to inspect the relevant region.",
    argsSchema: ReadFileArgsSchema,
  },
  view_file: {
    description:
      "Read a bounded file window with line numbers. Use this instead of full read_file when diagnostics or grep point to a specific range.",
    argsSchema: ViewFileArgsSchema,
  },
  list_directory: {
    description: "List directory entries",
    argsSchema: ListDirectoryArgsSchema,
  },
  grep_search: {
    description: "Search text across files",
    argsSchema: GrepSearchArgsSchema,
  },
  skim_file: {
    description: "Prune large file content with local SWE-pruner/heuristic skimming",
    argsSchema: SkimFileArgsSchema,
  },
  inspect_environment: {
    description: "Inspect available runtimes/package managers, manifests, dependency state, and Reaper scratchpad/cache paths before deciding whether installs or tool setup are required.",
    argsSchema: InspectEnvironmentArgsSchema,
  },
  create_checkpoint: {
    description:
      "Create a recoverable git-backed checkpoint under .reaper/checkpoints before a risky mutation batch. Stores metadata plus tracked staged/worktree patches; ignored files are not included.",
    argsSchema: CreateCheckpointArgsSchema,
  },
  restore_checkpoint: {
    description:
      "Explicitly restore a named Reaper checkpoint in the current git workspace. This resets tracked files to the checkpoint base, removes new untracked files, and reapplies the checkpoint's saved pre-existing patches.",
    argsSchema: RestoreCheckpointArgsSchema,
  },
  git_status: {
    description: "Read-only git status summary for the current workspace.",
    argsSchema: GitStatusArgsSchema,
  },
  git_diff: {
    description: "Read-only git diff summary and bounded patch text for the current workspace.",
    argsSchema: GitDiffArgsSchema,
  },
  web_search: {
    description: "NATIVE RESEARCH: Search the web to solve complex problems, verify package versions before installation, or get clarity on unfamiliar frameworks. You MUST use this tool before 'npm install' for non-standard packages to avoid version hell. Synthesize results into actionable implementation or repair candidates.",
    argsSchema: WebSearchArgsSchema,
  },
  write_file: {
    description: "Write full file content",
    argsSchema: WriteFileArgsSchema,
  },
  replace_in_file: {
    description: "Replace text in file",
    argsSchema: ReplaceInFileArgsSchema,
  },
  edit_file: {
    description: "Multi-block search and replace. Highly efficient for large files. Each edit must uniquely identify a block of code using 'oldString' and provide 'newString' for replacement. Automatically handles quote and whitespace normalization.",
    argsSchema: EditFileArgsSchema,
  },
  replace_symbol: {
    description: "Replace a parsed symbol in file",
    argsSchema: ReplaceSymbolArgsSchema,
  },
  delete_file: {
    description: "Delete a file",
    argsSchema: DeleteFileArgsSchema,
  },
  run_shell_command: {
    description: "Run shell command in workspace. Use isBackground: true for long-running servers.",
    argsSchema: RunShellCommandArgsSchema,
  },
  sandbox_service_control: {
    description:
      "Host-side control for provided sibling services: list lifecycle/provenance, read logs, snapshot the mounted /app view, inspect the underlying image without mounts, restore an image-provided /app file, exec, write/copy non-image-provided files, and readiness-gated start/restart/recreate/stop. Use inspect_image for file/directory entrypoint mismatches before editing. Running is not treated as ready.",
    argsSchema: SandboxServiceControlArgsSchema,
  },
  browser_control: {
    description:
      "Control a persistent Playwright browser page: navigate, compact ref-based snapshot, screenshot, click/type/select by selector or ref (e.g. e0), press keys, scroll, or close. Use humanize:true when slower mouse/typing behavior is useful for UI reliability.",
    argsSchema: BrowserControlArgsSchema,
  },
  computer_control: {
    description:
      "Coordinate-level computer control for the active browser viewport: screenshot, mouse move/click/double-click/drag, keyboard type/press, and scroll. Use when DOM refs/selectors are unavailable; humanize:true enables slower curved mouse movement, typing delays, and chunked scrolling.",
    argsSchema: ComputerControlArgsSchema,
  },
  mouse_move: {
    description: "Native OS computer control: move the real mouse cursor to screen coordinates with a bounded human-like Bezier path.",
    argsSchema: MouseMoveArgsSchema,
  },
  mouse_click: {
    description: "Native OS computer control: move to screen coordinates, add small jitter/hesitation, then click left/right/middle one or more times.",
    argsSchema: MouseClickArgsSchema,
  },
  mouse_scroll: {
    description: "Native OS computer control: smooth inertial scrolling with deltaX/deltaY on the active desktop.",
    argsSchema: MouseScrollArgsSchema,
  },
  keyboard_type: {
    description: "Native OS computer control: type text into the focused app with variable delays; typoProbability is optional and defaults to zero.",
    argsSchema: KeyboardTypeArgsSchema,
  },
  keyboard_press: {
    description: "Native OS computer control: press a key or key combination such as ['ctrl','c']; dangerous combos are blocked unless explicitly authorized.",
    argsSchema: KeyboardPressArgsSchema,
  },
  screenshot: {
    description: "Native OS computer control: capture the full screen or a region and return base64 or a saved artifact path.",
    argsSchema: ScreenshotArgsSchema,
  },
  get_screen_size: {
    description: "Native OS computer control: return current screen width and height.",
    argsSchema: EmptyArgsSchema,
  },
  get_mouse_position: {
    description: "Native OS computer control: return current mouse x/y coordinates.",
    argsSchema: EmptyArgsSchema,
  },
  wait: {
    description: "Native OS computer control: wait for a number of seconds with optional jitter.",
    argsSchema: WaitArgsSchema,
  },
  start_live_view: {
    description: "Native OS computer control: start a local MJPEG screen stream and supervisor/approval UI, default http://127.0.0.1:8765/live.",
    argsSchema: StartLiveViewArgsSchema,
  },
  stop_live_view: {
    description: "Native OS computer control: stop the local live screen stream and supervisor UI.",
    argsSchema: EmptyArgsSchema,
  },
  request_human_approval: {
    description: "Native OS computer control: block for local human approval with Approve, Deny, or Take Over in the supervisor UI.",
    argsSchema: RequestHumanApprovalArgsSchema,
  },
  is_human_intervening: {
    description: "Native OS computer control: check whether human takeover is currently active.",
    argsSchema: EmptyArgsSchema,
  },
  read_background_output: {
    description: "Read stdout/stderr of a background process",
    argsSchema: ReadBackgroundOutputArgsSchema,
  },
  signal_process: {
    description: "Send a signal (SIGINT, SIGTERM, etc.) to a background process group.",
    argsSchema: SignalProcessArgsSchema,
  },
  write_to_process: {
    description: "Write text to the stdin of a background process.",
    argsSchema: WriteToProcessArgsSchema,
  },
  get_tool_output: {
    description: "Read a stored artifact output",
    argsSchema: GetToolOutputArgsSchema,
  },
  activate_skill: {
    description: "Activates a specialized agent skill by name (Available: 'skill-creator', 'github', etc.). Returns the skill's instructions wrapped in <activated_skill> tags.",
    argsSchema: ActivateSkillArgsSchema,
  },
  complete_task: {
    description: "Signal task completion and trigger verification",
    argsSchema: CompleteTaskArgsSchema,
  },
  advance_step: {
    description: "Signal that the current plan step is complete and Reaper should move to the next step. This is a control-plane signal, not a filesystem operation.",
    argsSchema: AdvanceStepArgsSchema,
  },
  request_patch: {
    description: "Executor control-plane signal: stop execution and ask the parent to call the patcher sub-agent for a scoped code/test fix, then resume the same blocked step.",
    argsSchema: RequestPatchArgsSchema,
  },
  delegate_to_plan: {
    description: "Delegate work to orchestrated sub-agents",
    argsSchema: DelegateToPlanArgsSchema,
  },
  web_fetch: {
    description: "Fetch and extract text content from a URL. Use for reading documentation, API references, or any web page.",
    argsSchema: WebFetchArgsSchema,
  },
  task_create: {
    description:
      "Create a task in the session todo list. Use proactively for any work requiring 3+ distinct steps, multi-file changes, or multiple features. Each task has an imperative 'subject' (e.g. 'Add auth middleware') and a 'description' of what done looks like. Decompose the user's request into specific, actionable tasks at the start of work; add new ones as you discover follow-up work.",
    argsSchema: TaskCreateArgsSchema,
  },
  task_update: {
    description:
      "Update a task's status. Set status='in_progress' BEFORE starting work on it; set status='completed' IMMEDIATELY after finishing (do not batch completions). Exactly ONE task should be in_progress at a time. Only mark completed when fully accomplished (tests passing, implementation finished, no unresolved errors).",
    argsSchema: TaskUpdateArgsSchema,
  },
  task_list: {
    description:
      "List current todos with their statuses. Call this when uncertain what to work on next, or to confirm the task list is up to date before completion.",
    argsSchema: TaskListArgsSchema,
  },
  search_tools: {
    description:
      "Search available tools by keyword or direct select:<tool_name>. Call this when you need a capability not shown in the current tool list (e.g. background processes, web fetching, symbol rename). Returns matching tool names and descriptions, and promotes them to full-schema rendering on subsequent turns.",
    argsSchema: SearchToolsArgsSchema,
  },
  agent: {
    description:
      "Delegate a focused task to a subagent and get a compact summary back. The subagent has its own context and tool set; you only see its final summary. Use this when work can be cleanly isolated, parallelized, or has a clearly bounded scope. Built-in types: `coder` (default; full read/write/test/command), `explore` (read-only fast codebase exploration), `plan` (read-only planning). Subagents cannot spawn further subagents by default.",
    argsSchema: AgentArgsSchema,
  },
  agent_swarm: {
    description:
      "Fan out a task to many subagents in parallel from a single tool call. Provide a `prompt_template` containing the `{{item}}` placeholder and an `items` list — each element is substituted in and launches one subagent. Up to 128 items, bounded concurrency. Each subagent's transcript is independent; you only see the consolidated `<agent_swarm_result>` block. Use this when you have many independent investigations or tasks that can run in parallel.",
    argsSchema: AgentSwarmArgsSchema,
  },
  /* ----- Skill authoring (5) ----- */
  create_skill: {
    description:
      "Author a new skill from a description. Writes a draft `skill.json` + `SKILL.md` to `<workspace>/.reaper/skills/<name>/`. The skill is `trust: \"draft\"` until `approve_skill` promotes it (gated by `request_human_approval`).",
    argsSchema: CreateSkillArgsSchema,
  },
  test_skill: {
    description:
      "Run the skill's `validation.commands` in order and report per-command exit codes + stderr. Fails-fast on the first non-zero exit. Updates `lastValidatedAt` on success.",
    argsSchema: TestSkillArgsSchema,
  },
  approve_skill: {
    description:
      "Promote a draft skill to `user-trusted`. Gated by `request_human_approval` — the user sees the skill description + draft path before approval.",
    argsSchema: ApproveSkillArgsSchema,
  },
  uninstall_skill: {
    description:
      "Remove a skill from the registry + SkillMemoryRegistry + disk. Gated for any non-draft trust level.",
    argsSchema: UninstallSkillArgsSchema,
  },
  reload_skills: {
    description:
      "Re-walk the skill install dirs and rebuild the in-memory `SkillRegistry`. Useful after hand-editing or copying skill folders in. Cheap.",
    argsSchema: ReloadSkillsArgsSchema,
  },
  /* ----- Extension authoring (6, JS only) ----- */
  create_extension: {
    description:
      "Author a new extension from a description. Writes `extension.json` + `main.js` to `<workspace>/.reaper/extensions/<id>/`. Extensions are JS-only (no TypeScript). The extension lands dormant as `project-untrusted` until `trust_extension` + `enable_extension` activate it.",
    argsSchema: CreateExtensionArgsSchema,
  },
  validate_extension: {
    description: "Run the extension's `validation.commands` (if any) and report exit codes. Does NOT activate the extension.",
    argsSchema: ValidateExtensionArgsSchema,
  },
  enable_extension: {
    description:
      "Mark the extension `enabled` and run `default.activate(ctx)` via the HookRunner envelope. On success, copies the extension's tools into the live executor dispatch on the next turn. Requires the extension to be `user-trusted` first.",
    argsSchema: EnableExtensionArgsSchema,
  },
  trust_extension: {
    description: "Promote an extension from `project-untrusted` to `user-trusted`. Gated by `request_human_approval`.",
    argsSchema: TrustExtensionArgsSchema,
  },
  uninstall_extension: {
    description: "Remove an extension from the registry + disk. Gated by `request_human_approval`.",
    argsSchema: UninstallExtensionArgsSchema,
  },
  reload_extensions: {
    description:
      "Re-walk the extension install dirs (built-in + user + project). Returns the count of loaded extensions. Use after hand-placing an extension folder.",
    argsSchema: ReloadExtensionsArgsSchema,
  },
  /* ----- Hook authoring (6, event-driven) ----- */
  create_hook: {
    description:
      "Author a new event hook from a description. Writes a draft `<scope-root>/.reaper/hooks/<id>.json`. Drafts are NOT registered on the live `HookRunner` — call `approve_hook` to compile + register. Hooks default to `enforce: false` (observation-only).",
    argsSchema: CreateHookArgsSchema,
  },
  list_hooks: {
    description:
      "Read-only inventory of the hook registry: id, event, description, matcher, enforce flag, trust, compiled + registered flags. Use to check the live state before approving or updating.",
    argsSchema: ListHooksArgsSchema,
  },
  update_hook: {
    description:
      "Re-compile and re-register a hook. Re-approval is required if `enforce` flips from false to true (the hook gains blocking power).",
    argsSchema: UpdateHookArgsSchema,
  },
  approve_hook: {
    description:
      "Compile the hook's JS handler with `new Function('event', body)` and register on the live `HookRunner`. Gated by `request_human_approval` — the user sees the description, matcher, `enforce` flag, and the first 4KB of source before approval.",
    argsSchema: ApproveHookArgsSchema,
  },
  uninstall_hook: {
    description: "Remove a hook from disk + the live `HookRunner`. Gated by `request_human_approval` for non-draft hooks.",
    argsSchema: UninstallHookArgsSchema,
  },
  reload_hooks: {
    description: "Re-walk the hook install dirs and rebuild the in-memory hook registry. Useful after hand-editing.",
    argsSchema: ReloadHooksArgsSchema,
  },
} as const;

/**
 * Tools always rendered with full schemas on every turn.
 * Everything else appears as a one-line name+description in the deferred list
 * until the model discovers it via search_tools.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "read_file",
  "view_file",
  "write_file",
  "edit_file",
  "replace_in_file",
  "delete_file",
  "list_directory",
  "grep_search",
  "run_shell_command",
  "sandbox_service_control",
  "advance_step",
  "complete_task",
  "task_create",
  "task_update",
  "task_list",
  "search_tools",
  "agent",
  "agent_swarm",
  "delegate_to_plan",
]);

export type ToolName = keyof typeof toolRegistry;

/**
 * Tools rendered as one-line name+description in the deferred list on every
 * turn (until the model promotes them via search_tools). Everything not in
 * CORE_TOOL_NAMES lands here automatically — MCP and extension tools are
 * added at runtime by their respective registries.
 */
export const ON_DEMAND_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(toolRegistry).filter((name) => !CORE_TOOL_NAMES.has(name)),
);
