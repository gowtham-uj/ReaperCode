# Reaper main agent — tool inventory

30 tools are registered. The wire carries a schema for **11** of them on
every model call; the other **19** are named in the system prompt and unlocked by
`search_tools` (keyword, or `select:<name>`).

Mark a tool **Drop** below and the next change takes it out of `toolRegistry`; mark one **Pin**
and it moves into `CORE_TOOL_NAMES` so it ships with a full schema every turn. Nothing here is
enforced by the file itself — it is a worklist.

## Core — full schema on every call (11)

| Tool | What it does |
| --- | --- |
| `bash` | Run a shell command in the workspace for real execution: package installs, tests, builds, typechecks, dev-server smoke checks, or concise environment probes. Required argument: `cmd`. Optional `timeout` is in SECONDS (1-3600) and defaults to 60; `description` is optional. Use `run_in_background: true` only for a tracked process that must outlive the call, then stop it when finished. Do not use bash for file reads, listings, searches, or edits when file_view, list_directory, grep_search, file_edit, or write_file can do the work. Large output returns a bounded preview and persisted output path; inspect that path with file_view instead of rerunning. After a failed broad build or test, inspect the focused failure before repeating the command. |
| `eval` | Execute JavaScript in Reaper's sandboxed QuickJS runtime. |
| `file_edit` | Edit a single contiguous line range and run the configured language linter on the result. On lint failure the file is rolled back atomically and the error is returned to the model (file content is never left in a broken state). Always pass `expected_content`: the exact text currently occupying start_line..end_line. Every edit shifts the lines below it, so line numbers read earlier in the turn are stale; with the anchor the edit is relocated or refused instead of splicing into the wrong block. The response returns the edited region as it now reads — use those line numbers for the next edit, not the ones you read before. |
| `file_view` | View a numbered window of a file (default 50 lines starting at line 1). The model always sees line numbers in the response; move through a large file by passing an explicit start_line. Bounded by file_line_limit_max (config; default 500 lines per response). |
| `git_diff` | Read-only git diff summary and bounded patch text for the current workspace. |
| `git_status` | Read-only git status summary for the current workspace. |
| `glob` | Find files matching a glob pattern without using bash. Supports patterns like 'src/tools/*.ts' or 'double-star recursive matching'. Returns matching file paths and count. Faster and more structured than 'bash find'. |
| `grep_search` | Search text with a per-line regular expression. `path` may be a directory (searched recursively) or a single file, so locating a pattern in one known file is one call rather than a directory sweep. Optional `include` filters by glob. Returns the file, line number, and matching line for each hit. |
| `list_directory` | List directory entries |
| `search_tools` | Search available tools by keyword or direct select:<tool_name>. Call this when you need a capability not shown in the current tool list (e.g. background processes, web fetching, symbol rename). Returns matching tool names and descriptions, and promotes them to full-schema rendering on subsequent turns. |
| `write_file` | Write complete file content. Creates the file if it doesn't exist and automatically creates parent directories. Use for new files or intentional full rewrites; prefer many focused write_file calls over one giant generated blob when creating several independent files. |

## Deferred — behind `search_tools` (19)

| Tool | What it does | Drop? | Pin? |
| --- | --- | --- | --- |
| `activate_skill` | Activates a specialized agent skill by name (Available: 'skill-creator', 'github', etc.). Returns the skill's instructions wrapped in <activated_skill> tags. | |  |  |
| `apply_patch_edit` | Apply a unified-diff patch that can modify multiple files in a single call. Supports new file creation (--- /dev/null), context lines, additions, and removals. Use for multi-file edits or when you need to apply a diff from an external source. Post-write diagnostics are advisory only. Pass dry_run:true to preview without writing. | |  |  |
| `browser_control` | Control a persistent Playwright browser page: navigate, compact ref-based snapshot, screenshot, click/type/select by selector or ref (e.g. e0), press keys, scroll, or close. Use humanize:true when slower mouse/typing behavior is useful for UI reliability. | |  |  |
| `create_checkpoint` | Create a recoverable git-backed checkpoint under .reaper/checkpoints before a risky mutation batch. Stores metadata plus tracked staged/worktree patches; ignored files are not included. | |  |  |
| `delete_file` | Delete a file | |  |  |
| `diagnostics` | Run post-write diagnostics (tsc, eslint) on a file and return results as advisory info. Never blocks the write — just reports. Use after editing a file to check for type or lint errors. | |  |  |
| `edit_file` | Multi-block search and replace. Highly efficient for large files. Each edit must uniquely identify a block of code using 'oldString' and provide 'newString' for replacement. Automatically handles quote and whitespace normalization. | |  |  |
| `extension_manager` | Author and manage extensions (JavaScript only). Actions: create (writes `extension.json` + `main.js` to `.reaper/extensions/<id>/`, lands dormant as `project-untrusted`), validate (runs `validation.commands`, does not activate), trust (promotes to `user-trusted`; gated), enable (marks enabled and runs `default.activate(ctx)`; requires `user-trusted` first), uninstall (removes from registry and disk; gated). | |  |  |
| `file_find` | Find the first occurrence of a pattern within a single file and recenter the viewport on it. Pattern is a literal substring (no regex). Returns a numbered window around the match. | |  |  |
| `hook_manager` | Author and manage event hooks. Actions: create (writes a draft `.reaper/hooks/<id>.json`; drafts are NOT registered on the live runner), list (read-only inventory: id, event, matcher, enforce, trust, compiled/registered flags), update (re-compile and re-register; re-approval required if `enforce` flips to true), approve (compiles with `new Function` and registers; gated — the user sees the description, matcher, enforce flag, and first 4KB of source), uninstall (removes from disk and the live runner; gated for non-drafts). | |  |  |
| `inspect_environment` | Inspect available runtimes/package managers, manifests, dependency state, and Reaper scratchpad/cache paths before deciding whether installs or tool setup are required. | |  |  |
| `job` | Background processes already started by bash (run_in_background: true). Actions: list (all jobs), poll (read output), cancel (send signal), write (to stdin). jobId is the pid bash returned. Cannot start processes — use bash for that. | |  |  |
| `restore_checkpoint` | Explicitly restore a named Reaper checkpoint in the current git workspace. This resets tracked files to the checkpoint base, removes new untracked files, and reapplies the checkpoint's saved pre-existing patches. | |  |  |
| `scratchpad` | Append, read, or clear notes at `.reaper/memory/scratch.md`. Available when needed; follow the user request for when to use it. | |  |  |
| `search_memory` | Search prior session summaries persisted under `.reaper/summaries/`. Use after compaction or on resume to recall what the agent was doing earlier. | |  |  |
| `skill_manager` | Author and manage skills. Actions: create (writes a draft `skill.json` + `SKILL.md` to `.reaper/skills/<name>/`, `trust: "draft"`), test (runs the skill's `validation.commands` in order, fails fast), approve (promotes a draft to `user-trusted`; gated by the approval flow), uninstall (removes it from the registry and disk; gated for any non-draft). | |  |  |
| `skim_file` | Prune large file content with local SWE-pruner/heuristic skimming | |  |  |
| `web_fetch` | Fetch and extract text content from a URL. Use for reading documentation, API references, or any web page. | |  |  |
| `web_search` | NATIVE RESEARCH: Search the web to solve complex problems, verify package versions before installation, or get clarity on unfamiliar frameworks. You MUST use this tool before 'npm install' for non-standard packages to avoid version hell. Synthesize results into actionable implementation or repair candidates. | |  |  |

---

## Grouped view of the deferred set

- **Files and search:** skim_file, edit_file, file_find, delete_file, inspect_environment, diagnostics, apply_patch_edit
- **Git and checkpoints:** create_checkpoint, restore_checkpoint
- **Background processes:** job
- **Web:** web_search, web_fetch
- **Browsers:** browser_control
- **Skill authoring:** activate_skill, skill_manager
- **Extension authoring:** extension_manager
- **Hook authoring:** hook_manager
- **Memory:** search_memory, scratchpad

Regenerate with `node --import=tsx scripts/emit-tool-list.mts`.
