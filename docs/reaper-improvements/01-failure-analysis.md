# Failure Analysis — Initial-Tasks Eval

## Source

Eval logs under `/workspace/results/` and `/workspace/.reaper-runs/` from running
`scripts/run-initial-tasks.ts` against the 5-task initial benchmark with `qwen-3-235b`.

## Headline

5/5 tasks failed. Across the runs, **83 distinct tool-failure events** were recorded. The
distribution shows the failures are dominated by **model-quality issues**, not reaper bugs —
Reaper's safety guards correctly catch them; they just terminate progress because the model
cannot recover.

## Failure-mode breakdown

| Category | Count | Cause | Reaper behavior |
|---|---|---|---|
| `stale_write_requires_read` | ~31 | Model writes a file it has not Read this turn; safety guard rejects. | Guard fires correctly. Model often retries with the same write rather than reading first. |
| `ENOENT` on `read_file` / `replace_in_file` | ~22 | Model hallucinates a path that does not exist (often a confident guess based on conventions). | Correct error returned. Model rarely uses `list_directory` to recover. |
| `run_shell_command` exit ≠ 0 | ~18 | Model issues malformed command (missing flag, wrong cwd, unquoted glob), or invokes a tool/binary that isn't installed. | Exit code + stderr surfaced. No retry-with-fix loop. |
| `replace_in_file` no-match | ~7 | `oldString` does not appear verbatim in the file (whitespace / quote / encoding drift). | Correct error. `edit_file` would normalize but model picks the wrong tool. |
| Misc (timeouts, JSON parse) | ~5 | Background processes hanging; malformed structured output. | Caught and surfaced. |

## What this implies for prioritization

The fixes that actually move the needle are **not** reaper-side bug fixes — they are
**prompt + workflow** changes that shape the model's behavior:

1. **TodoWrite-style task decomposition** ⟹ forces the model to plan before it writes,
   which strongly reduces stale-write retries (planning step usually pulls a Read first).
2. **Progressive tool discovery (ToolSearch)** ⟹ shrinks the prompt and gives the model a
   stronger signal about which tool fits a sub-problem (reduces `replace_in_file` vs `edit_file`
   misuse and reduces shell-command misuse).
3. **Better model** ⟹ qwen-3-235b is the bottleneck. Anthropic Opus/Sonnet would not
   hallucinate paths as often. But we cannot change models for the benchmark, so we squeeze
   reliability from prompting.

This is what cc-haha gets right: structured todos + lazy tool catalog. Hence the port plan.

## Notes / open questions

- We never wired up a recovery loop that auto-suggests `list_directory` when the model gets
  `ENOENT`. That could be a quick win — a small "guard" message in the tool result.
- The `stale_write` guard message could explicitly tell the model to `read_file` first; it
  currently just states the rule.
