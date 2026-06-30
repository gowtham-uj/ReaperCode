# Next Steps — TB Phase-1 In Progress

## ✅ Completed since the previous version of this doc

1. **8 typecheck errors fixed.** Threaded `runId: string` through 5 prompt-builder signatures
   (`buildSimpleExecutorPrompt`, `buildAutonomousRepairPrompt`, `buildSimplifyRecoveryPrompt`,
   `buildModelCompletionPrompt`, `buildPatcherSubagentPrompt`); each call site inside the
   class method passes `getBoot().state.runId`. Added `search_tools` discriminant to
   `ToolCallSchema` in `src/tools/types.ts` (with `SearchToolsArgsSchema` moved into
   `types.ts` to break the circular import).
2. **Shortlist seeding.** After `prepareRuntimeContent(...)` in `contentPrepNode`:
   ```ts
   if (prepared?.toolShortlist?.length) {
     discoverTools(prepared.toolShortlist.map((t) => t.name), getBoot().state.runId);
   }
   ```
   Gives the model a warm set of relevant non-core tools on turn 1.
3. **Smoke tests green.**
   - `executeSearchTools("background process", "run-1")` → matches
     `read_background_output, signal_process, write_to_process, search_tools, run_shell_command`;
     per-run isolation verified.
   - Contract counts: 14 core tools, 12 deferred, dynamic union after discovery confirmed.
4. **Typecheck clean.** `npx tsc --noEmit` returns zero errors.

## 🚀 In progress: TB Phase-1 (25 tasks)

Launched 2026-05-28T02:10Z. Background PID 107366 wraps the TB harness via
`run_all_terminal_bench_reaper.py`.

- **Output dir:** `/workspace/reaper_eval/terminal-bench-runs/reaper-phase1-toolsearch/`
- **Log:** `/workspace/reaper_eval/terminal-bench-runs/reaper-phase1-toolsearch.log`
- **State file:** `reaper-phase1-toolsearch/suite-state.jsonl` (one JSON record per task)
- **Provider/model:** `crazyrouter` / `Qwen/Qwen3.6-35B-A3B`
- **`STOP_ON_FAIL=0`** — we want full coverage, not early exit.
- **Tasks (25, selected by the run script's foundational filter):** broken-python,
  count-call-stack, fix-pandas-version, log-summary, modernize-scientific-stack,
  ancient-puzzle, cpp-compatibility, csv-to-parquet, fix-git, fix-permissions,
  grid-pattern-transform, processing-pipeline, build-cython-ext, cprofiling-python,
  html-finance-verify, incompatible-python-fasttext, tmux-advanced-workflow,
  debug-long-program, conda-env-conflict-resolution, accelerate-maximal-square,
  analyze-access-logs, cobol-modernization, create-bucket, extract-safely,
  heterogeneous-dates.

## After the run completes

1. Aggregate `suite-state.jsonl` → pass rate, failure-class histogram, prompt-token deltas.
2. Compare against the pre-port baseline in `01-failure-analysis.md` (5/5 fail, 83 tool
   failures dominated by stale_write / ENOENT / shell-exit).
3. For each failure, classify: is it still model-quality (path hallucination, bad commands),
   or did our changes introduce new modes?
4. Decide on the next reliability fix (likely: more explicit guard messages, e.g.
   stale_write should suggest `read_file` first; ENOENT should suggest `list_directory`).

## Quick monitoring

```bash
# Tail the launcher log
tail -F /workspace/reaper_eval/terminal-bench-runs/reaper-phase1-toolsearch.log

# Inspect state as it grows
tail -F /workspace/reaper_eval/terminal-bench-runs/reaper-phase1-toolsearch/suite-state.jsonl

# Per-task result
cat /workspace/reaper_eval/terminal-bench-runs/reaper-phase1-toolsearch/<run-id>/results.json
```
