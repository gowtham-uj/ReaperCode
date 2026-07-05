import {
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
  SearchToolsArgsSchema,
} from "./types.js";
import {
  FileViewArgsSchema,
  FileScrollArgsSchema,
  FileFindArgsSchema,
  FileEditArgsSchema,
} from "./viewer/types.js";
import { ApplyPatchArgsSchema } from "./apply-patch.js";
import { GlobArgsSchema } from "./glob.js";
import { EvalArgsSchema } from "./eval.js";
import { JobArgsSchema } from "./job.js";
import { AstGrepArgsSchema, DiagnosticsArgsSchema } from "./ast-grep.js";
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
    description:
      "Replace text in a file. Prefer exact oldString/newString only when you just read the current text or are patching a small stable block. If a replace_in_file call fails with string-not-found, do not repeat the same oldString; immediately read_file around the target or retry with startLine/endLine/content using the current file text.",
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
  // ---- viewer tools (Phase 2: schemas registered, NOT in CORE_TOOL_NAMES yet).
  file_view: {
    description:
      "View a numbered window of a file (default 50 lines starting at line 1). Preferred over read_file for inspection; the model always sees line numbers in the response. Use file_scroll to navigate within the same file. Bounded by file_line_limit_max (config; default 500 lines per response).",
    argsSchema: FileViewArgsSchema,
  },
  file_scroll: {
    description:
      "Move the viewport for an already-viewed file. Direction: up/down/top/bottom. Lines optional (defaults to the previous window size). Reuses the same viewport as file_view / file_find for the same file.",
    argsSchema: FileScrollArgsSchema,
  },
  file_find: {
    description:
      "Find the first occurrence of a pattern within a single file and recenter the viewport on it. Pattern is a literal substring (no regex). Returns a numbered window around the match.",
    argsSchema: FileFindArgsSchema,
  },
  file_edit: {
    description:
      "Edit a single contiguous line range and run the configured language linter on the result. On lint failure the file is rolled back atomically and the error is returned to the model (file content is never left in a broken state). Preferred over replace_in_file for line-anchored edits because oldString never has to be guessed.",
    argsSchema: FileEditArgsSchema,
  },
  // -------------------------------------------------------------------------------
  bash: {
    description:
      "Run a bash command in the workspace for real execution: package installs, tests, builds, typechecks, dev-server smoke checks, or concise environment probes. " +
      "REQUIRED per call: a concise `description` and an explicit `timeout` (in SECONDS — e.g. 300 for ~5 minutes). The bash tool has NO DEFAULT TIMEOUT; if the model omits `timeout`, the call fails with a clear schema error. " +
      "Do not use bash as a file reader (`cat`, `ls`, `find`) for files you just wrote; the cockpit's Changed Files section already summarizes shipped artifacts. " +
      "Prefer `read_file` for targeted file inspection only when a write failed or a verifier points to a concrete line. " +
      "If output is large, inspect the returned log/spillover path with `read_file` rather than re-running. " +
      "SERVER LIFECYCLE: when you start a server for a smoke test or for active probing (e.g. `pnpm dev`, `node dist/index.js`, `python -m http.server`), it MUST be self-cleaning. " +
      "Use one of: (a) `isBackground: true` / `run_in_background: true` to start it as a tracked background process you can stop later, or (b) a single-shot bounded command like `timeout 30 pnpm dev & sleep 5; curl ...; kill $! 2>/dev/null || true`, or (c) `trap 'kill $PID 2>/dev/null || true' EXIT` inside the command. " +
      "Do not leave a foreground server attached to stdio — the wrapper cannot close until it does, and your own subsequent tool calls will hang. " +
      "If the user explicitly asks you to keep a server running, use `isBackground: true` so the runtime tracks it; otherwise spin it down inside the same command. " +
      "After a failed broad build/test, run a targeted diagnostic/check before repeating the broad command unchanged.",
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
  web_fetch: {
    description: "Fetch and extract text content from a URL. Use for reading documentation, API references, or any web page.",
    argsSchema: WebFetchArgsSchema,
  },
  search_tools: {
    description:
      "Search available tools by keyword or direct select:<tool_name>. Call this when you need a capability not shown in the current tool list (e.g. background processes, web fetching, symbol rename). Returns matching tool names and descriptions, and promotes them to full-schema rendering on subsequent turns.",
    argsSchema: SearchToolsArgsSchema,
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
  apply_patch_edit: {
    description:
      "Apply a unified-diff patch that can modify multiple files in a single call. Supports new file creation (--- /dev/null), context lines, additions, and removals. Use for multi-file edits or when you need to apply a diff from an external source. Post-write diagnostics are advisory only. Pass dry_run:true to preview without writing.",
    argsSchema: ApplyPatchArgsSchema,
  },
  glob: {
    description:
      "Find files matching a glob pattern without using bash. Supports patterns like 'src/tools/*.ts' or 'double-star recursive matching'. Returns matching file paths and count. Faster and more structured than 'bash find'.",
    argsSchema: GlobArgsSchema,
  },
  eval: {
    description:
      "Evaluate a short JavaScript or Python code snippet and return the output. Faster than bash for small computations, counting, or AST probes. Supports timeout (default 10s, max 30s). Use 'javascript' (default) or 'python' language.",
    argsSchema: EvalArgsSchema,
  },
  job: {
    description:
      "Unified facade over background processes. Actions: start (background command), list (all jobs), poll (read output), cancel (send signal), write (to stdin). Unifies read_background_output + signal_process + write_to_process.",
    argsSchema: JobArgsSchema,
  },
  ast_grep: {
    description:
      "Search for symbol declarations (functions, classes, methods, variables) across the codebase by name. Returns file, line, kind, and snippet. Supports language and kind filters. Faster and more precise than grep for code navigation.",
    argsSchema: AstGrepArgsSchema,
  },
  diagnostics: {
    description:
      "Run post-write diagnostics (tsc, eslint) on a file and return results as advisory info. Never blocks the write — just reports. Use after editing a file to check for type or lint errors.",
    argsSchema: DiagnosticsArgsSchema,
  },
} as const;

/**
 * Tools always rendered with full schemas on every turn.
 * Everything else appears as a one-line name+description in the deferred list
 * until the model discovers it via search_tools.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  // ---- viewer (Phase 4: promoted to always-on so the model sees them every turn) ----
  "file_view",
  "file_scroll",
  "file_find",
  "file_edit",
  // ---- legacy fallbacks (Phase 4: demoted to on-demand; reach for the viewer equivalents) ----
  "view_file",          // on-demand legacy alias for file_view
  "write_file",         // always-on: full-file rewrites for new files + intentional overrides
  "edit_file",          // on-demand: legacy edit-by-edits tool (prefer file_edit)
  "delete_file",
  "list_directory",
  "grep_search",        // always-on: cross-file patterns
  "bash",               // always-on: tests, git, installs only
  "search_tools",
]);

// Tools that were demoted from CORE_TOOL_NAMES in Phase 4. Kept registered
// in `toolRegistry` for back-compat but no longer in the model's per-turn
// shortlist. The model reaches them via `search_tools("discover:read_file")`
// or `search_tools("discover:replace_in_file")`. Phase 5 replaces the first
// with an auto-aliased file_view shim; Phase 5 removes the second entirely
// and substitutes a synonym alias that routes to file_edit's schema.
export const DEMOTED_LEGACY_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "read_file",
  "replace_in_file",
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
