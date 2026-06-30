# ToolSearch Port — ✅ Complete

Port done. Typecheck clean. Per-run isolation verified.

## What landed

- **`src/tools/discovery.ts`** (new) — per-run discovery store
  `getDiscoveredTools(runId)` / `discoverTools(names, runId)` / `clearDiscoveredTools(runId)`.
- **`src/tools/write/search-tools.ts`** (new) — `executeSearchTools(query, runId)`. Scores all
  registry entries, returns top 6 matches, side-effects `discoverTools` for the run.
- **`src/tools/types.ts`** — added `SearchToolsArgsSchema` (moved here to avoid circular
  import between `registry.ts` and `write/search-tools.ts`) and a new discriminant
  `{ name: "search_tools", args: SearchToolsArgsSchema }` in `ToolCallSchema`.
- **`src/tools/registry.ts`** — added `search_tools` entry and `CORE_TOOL_NAMES` constant
  (14 tools).
- **`src/tools/executor.ts`** — `case "search_tools"` dispatch passes `this.options.runId`.
- **`src/runtime/engine.ts`**
  - `renderToolCallContract(runId?)` is now dynamic: full schemas for
    `CORE_TOOL_NAMES ∪ getDiscoveredTools(runId)`; one-line `<deferred_tools>` block for the
    rest with a hint pointing at `search_tools`.
  - Threaded `runId: string` through 5 prompt-builder signatures (`buildSimpleExecutorPrompt`,
    `buildAutonomousRepairPrompt`, `buildSimplifyRecoveryPrompt`, `buildModelCompletionPrompt`,
    `buildPatcherSubagentPrompt`) and updated each call site to pass `getBoot().state.runId`.
    `buildStepExecutionPrompt` already took `runId` from the TodoWrite port.
- **`src/context/tool-search.ts`** — `scoreTool` exported.

## Smoke test

```
matches for "background process": [
  read_background_output, signal_process, write_to_process, search_tools, run_shell_command
]
discovered run-1 after: same 5
discovered run-2 ("web fetch"): [web_fetch, web_search, search_tools]
run-1 unchanged after run-2 calls    ✅ isolation works
```

## Resolved blockers

- **`getBoot` scope** — `getBoot` is a closure local to the class method. Fix: each affected
  top-level builder now takes `runId: string` in its input bag; callers (all inside the class
  method) pass `getBoot().state.runId`.
- **`search_tools` missing in `ToolCallSchema`** — added the discriminant; circular import
  resolved by moving `SearchToolsArgsSchema` into `types.ts` and re-exporting from
  `write/search-tools.ts`.

## Verification commands

```bash
npx tsc --noEmit                                                    # zero errors
TASK_INDEX=0 npx tsx scripts/run-single-initial-task.ts             # end-to-end
```
