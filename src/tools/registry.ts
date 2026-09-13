import {
  DeleteFileArgsSchema,
  GrepSearchArgsSchema,
  ListDirectoryArgsSchema,
  SkimFileArgsSchema,
  InspectEnvironmentArgsSchema,
  CreateCheckpointArgsSchema,
  RestoreCheckpointArgsSchema,
  GitStatusArgsSchema,
  GitDiffArgsSchema,
  WebSearchArgsSchema,
  EditFileArgsSchema,
  BashArgsSchema,
  BrowserControlArgsSchema,
  WriteFileArgsSchema,
  ActivateSkillArgsSchema,
  WebFetchArgsSchema,
  SearchToolsArgsSchema,
  ScratchpadArgsSchema,
  SearchMemoryArgsSchema,
} from "./types.js";
import {
  FileViewArgsSchema,
  FileFindArgsSchema,
  FileEditArgsSchema,
} from "./viewer/types.js";
import { ApplyPatchArgsSchema } from "./apply-patch.js";
import { GlobArgsSchema } from "./glob.js";
import { JobArgsSchema } from "./job.js";
import { DiagnosticsArgsSchema } from "./diagnostics.js";
import {
  CreateSkillArgsSchema,
  TestSkillArgsSchema,
  ApproveSkillArgsSchema,
  UninstallSkillArgsSchema,
  SkillManagerArgsSchema,
} from "./types/skill-tools.schema.js";
import {
  CreateExtensionArgsSchema,
  ValidateExtensionArgsSchema,
  EnableExtensionArgsSchema,
  TrustExtensionArgsSchema,
  UninstallExtensionArgsSchema,
  ExtensionManagerArgsSchema,
} from "./types/extension-tools.schema.js";
import {
  CreateHookArgsSchema,
  ListHooksArgsSchema,
  UpdateHookArgsSchema,
  ApproveHookArgsSchema,
  UninstallHookArgsSchema,
  HookManagerArgsSchema,
} from "./types/hook-tools.schema.js";
import { EvalArgsSchema, EVAL_TOOL_DESCRIPTION } from "./eval.js";

export const toolRegistry = {
  list_directory: {
    description: "List directory entries",
    argsSchema: ListDirectoryArgsSchema,
  },
  grep_search: {
    description:
      "Search text with a per-line regular expression. `path` may be a directory (searched recursively) " +
      "or a single file, so locating a pattern in one known file is one call rather than a directory " +
      "sweep. Optional `include` filters by glob. Returns the file, line number, and matching line for " +
      "each hit.",
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
    description: "Write complete file content. Creates the file if it doesn't exist and automatically creates parent directories. Use for new files or intentional full rewrites; prefer many focused write_file calls over one giant generated blob when creating several independent files.",
    argsSchema: WriteFileArgsSchema,
  },
  edit_file: {
    description: "Multi-block search and replace. Highly efficient for large files. Each edit must uniquely identify a block of code using 'oldString' and provide 'newString' for replacement. Automatically handles quote and whitespace normalization.",
    argsSchema: EditFileArgsSchema,
  },
  delete_file: {
    description: "Delete a file",
    argsSchema: DeleteFileArgsSchema,
  },
  // ---- viewer tools (Phase 2: schemas registered, NOT in CORE_TOOL_NAMES yet).
  file_view: {
    description:
      "View a numbered window of a file (default 50 lines starting at line 1). The model always sees line numbers in the response; move through a large file by passing an explicit start_line. Bounded by file_line_limit_max (config; default 500 lines per response).",
    argsSchema: FileViewArgsSchema,
  },
  file_find: {
    description:
      "Find the first occurrence of a pattern within a single file and recenter the viewport on it. Pattern is a literal substring (no regex). Returns a numbered window around the match.",
    argsSchema: FileFindArgsSchema,
  },
  file_edit: {
    description:
      "Edit a single contiguous line range and run the configured language linter on the result. On lint failure the file is rolled back atomically and the error is returned to the model (file content is never left in a broken state). " +
      "Always pass `expected_content`: the exact text currently occupying start_line..end_line. Every edit shifts the lines below it, so line numbers read earlier in the turn are stale; with the anchor the edit is relocated or refused instead of splicing into the wrong block. " +
      "The response returns the edited region as it now reads — use those line numbers for the next edit, not the ones you read before.",
    argsSchema: FileEditArgsSchema,
  },
  // -------------------------------------------------------------------------------
  bash: {
    description:
      "Run a shell command in the workspace for real execution: package installs, tests, builds, typechecks, dev-server smoke checks, or concise environment probes. " +
      "Required argument: `cmd`. Optional `timeout` is in SECONDS (1-3600) and defaults to 60; `description` is optional. " +
      "Use `run_in_background: true` only for a tracked process that must outlive the call, then stop it when finished. " +
      "Do not use bash for file reads, listings, searches, or edits when file_view, list_directory, grep_search, file_edit, or write_file can do the work. " +
      "Large output returns a bounded preview and persisted output path; inspect that path with file_view instead of rerunning. " +
      "After a failed broad build or test, inspect the focused failure before repeating the command.",
    argsSchema: BashArgsSchema,
  },
  browser_control: {
    description:
      "Control a persistent Playwright browser page: navigate, compact ref-based snapshot, screenshot, click/type/select by selector or ref (e.g. e0), press keys, scroll, or close. Use humanize:true when slower mouse/typing behavior is useful for UI reliability.",
    argsSchema: BrowserControlArgsSchema,
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
  scratchpad: {
    description:
      "Append, read, or clear notes at `.reaper/memory/scratch.md`. Available when needed; follow the user request for when to use it.",
    argsSchema: ScratchpadArgsSchema,
  },
  search_memory: {
    description:
      "Search prior session summaries persisted under `.reaper/summaries/`. Use after compaction or on resume to recall what the agent was doing earlier.",
    argsSchema: SearchMemoryArgsSchema,
  },
  /*
   * Authoring, three tools instead of seventeen.
   *
   * Each family was a linear workflow — create, test/validate, approve/trust,
   * enable, uninstall, reload — where every step names the same skill or
   * extension, and the model had to hold the sequence and the exact verb for
   * its current position. As one tool with an `action` the whole workflow is
   * visible in a single schema, and getting to step three is a value change
   * rather than a name it has to have remembered or rediscovered.
   *
   * The three stay separate rather than becoming one `authoring` tool because
   * they act on three different stores with three different trust models, and
   * a single action enum would carry every field of every one of them — the
   * opposite of the disclosure this is meant to achieve.
   *
   * `activate_skill` is deliberately *not* folded in here. Activating is what
   * the agent does during ordinary work; authoring is what it does rarely, at
   * the user's direction. Grouping them would put a tool the model needs
   * constantly behind the same gate as one it should almost never reach for.
   */
  skill_manager: {
    description:
      "Author and manage skills. Actions: create (writes a draft `skill.json` + `SKILL.md` to `.reaper/skills/<name>/`, `trust: \"draft\"`), test (runs the skill's `validation.commands` in order, fails fast), approve (promotes a draft to `user-trusted`; gated by the approval flow), uninstall (removes it from the registry and disk; gated for any non-draft).",
    argsSchema: SkillManagerArgsSchema,
  },
  extension_manager: {
    description:
      "Author and manage extensions (JavaScript only). Actions: create (writes `extension.json` + `main.js` to `.reaper/extensions/<id>/`, lands dormant as `project-untrusted`), validate (runs `validation.commands`, does not activate), trust (promotes to `user-trusted`; gated), enable (marks enabled and runs `default.activate(ctx)`; requires `user-trusted` first), uninstall (removes from registry and disk; gated).",
    argsSchema: ExtensionManagerArgsSchema,
  },
  hook_manager: {
    description:
      "Author and manage event hooks. Actions: create (writes a draft `.reaper/hooks/<id>.json`; drafts are NOT registered on the live runner), list (read-only inventory: id, event, matcher, enforce, trust, compiled/registered flags), update (re-compile and re-register; re-approval required if `enforce` flips to true), approve (compiles with `new Function` and registers; gated — the user sees the description, matcher, enforce flag, and first 4KB of source), uninstall (removes from disk and the live runner; gated for non-drafts).",
    argsSchema: HookManagerArgsSchema,
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
  job: {
    description:
      "Background processes already started by bash (run_in_background: true). Actions: list (all jobs), poll (read output), cancel (send signal), write (to stdin). jobId is the pid bash returned. Cannot start processes — use bash for that.",
    argsSchema: JobArgsSchema,
  },
  diagnostics: {
    description:
      "Run post-write diagnostics (tsc, eslint) on a file and return results as advisory info. Never blocks the write — just reports. Use after editing a file to check for type or lint errors.",
    argsSchema: DiagnosticsArgsSchema,
  },
  eval: {
    description: EVAL_TOOL_DESCRIPTION,
    argsSchema: EvalArgsSchema,
  },
} as const;

/**
 * Tools always rendered with full schemas on every turn.
 * Everything else appears as a one-line name+description in the deferred list
 * until the model discovers it via search_tools.
 *
 * Eleven tools, chosen so a competent turn needs no discovery at all: find
 * (glob), read (file_view), edit in place (file_edit), rewrite (write_file),
 * search across files (grep_search), list (list_directory), run (bash),
 * compose (eval), and see what changed (git_status / git_diff). `search_tools`
 * is here because it is the escape hatch the other forty depend on — a
 * deferred list you cannot query is a list you cannot use.
 *
 * Two promotions and two demotions, each deliberate:
 * - `glob`, `git_status`, `git_diff` were on-demand and are not any more.
 *   Every real coding turn touches them, and each discovery round trip costs a
 *   model call to learn a schema the model already knows it needs.
 * - `delete_file` and `file_find` moved out. Deleting is rare and irreversible
 *   enough to deserve a discovery step, and `file_find` is a bounded window
 *   with a recentre, which `file_view` with an explicit range already covers
 *   without the viewport state.
 *
 * `eval` is core, and that is a deliberate reversal. It was withdrawn once —
 * the version in the tree ran `node -e` in a child process, which is not a
 * sandbox in any useful sense, and nothing about its description made a model
 * reach for it at the right moments. It is back as Code Mode: a QuickJS
 * interpreter with no host access except the tools the bridge hands it, and a
 * description written to route rather than to impress. It is core because a
 * tool that only works after the model has discovered it is a tool the model
 * will not think to reach for when a task turns out to want a loop — and the
 * decision to write a program instead of a dozen calls is exactly the decision
 * that has to be available before the first call, not after the fifth.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "bash",
  "file_view",
  "file_edit",
  "write_file",
  "grep_search",
  "list_directory",
  "glob",
  "git_status",
  "git_diff",
  "eval",
  "search_tools",
]);

// `read_file` and `replace_in_file` were removed entirely, and `view_file` and
// `file_scroll` were folded into `file_view`. Legacy `read`, `view_file`, and
// `file_scroll` spellings alias to `file_view`; `edit` and `replace` alias to
// `file_edit`. `edit_file` is a tool of its own — multi-block search and
// replace — and is not an alias of anything.

export type ToolName = keyof typeof toolRegistry;

/**
 * Tools rendered as one-line name+description in the deferred list on every
 * turn (until the model promotes them via search_tools). Everything not in
 * CORE_TOOL_NAMES lands here automatically — MCP and extension tools are
 * added at runtime by their respective registries.
 *
 * The split is load-bearing in a way that is easy to get wrong.
 * `renderAvailableTools` lists the *deferred* names and skips the core ones on
 * the assumption that core tools are already attached to the request. So a core
 * tool that gets narrowed off the wire is invisible in both directions: it is
 * absent from the schemas, and absent from the inventory that would have told
 * the model to go looking for it. Any code path that computes a reduced tool
 * set for the wire must therefore build it *from* `CORE_TOOL_NAMES` rather than
 * from a hand-written list — see `toCanonicalBuildFastStartTools` in
 * `runtime/engine.ts`, which had exactly this bug.
 */
export const ON_DEMAND_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(toolRegistry).filter((name) => !CORE_TOOL_NAMES.has(name)),
);
