# Reaper Improvement Journey

Living docs that record the work done to make Reaper as reliable as the reference
`cc-haha` agent (located at `/workspace/focus_sources/claude-repos/claude-extracted/cc-haha-main/`).

The goal: port cc-haha's task decomposition + tracking, port its progressive tool discovery
(ToolSearchTool), then run Terminal-Bench (TB) phase-1 problem set via the TB official CLI.

## Index

1. [01-failure-analysis.md](./01-failure-analysis.md) — Root-cause breakdown of the 83 tool
   failures we saw in initial-tasks eval logs.
2. [02-todowrite-port-complete.md](./02-todowrite-port-complete.md) — ✅ Completed port of
   cc-haha's TodoWrite into Reaper: per-run task store, registry descriptions, completion gate.
3. [03-toolsearch-port-complete.md](./03-toolsearch-port-complete.md) — ✅ Completed port
   of cc-haha's ToolSearchTool: dynamic schema rendering, per-run discovery store,
   typecheck clean, smoke test green.
4. [04-next-steps.md](./04-next-steps.md) — Remaining work: seed shortlist, run TB benchmarks.

## Pointers

- Approved plan file: `/home/coder/.claude/plans/keen-crafting-marble.md`
- Reference agent: `/workspace/focus_sources/claude-repos/claude-extracted/cc-haha-main/`
- Reaper source root: `/workspace/src/`
- Initial-task eval scripts: `/workspace/scripts/run-single-initial-task.ts`,
  `/workspace/scripts/run-initial-tasks.ts`

## Working rules from the user

- Root privileges authorized for file edits under `/workspace/src` via `sudo -n chown -R coder:coder`.
- Work one task at a time; do not over-scope across the three streams (TodoWrite → ToolSearch → TB).
- Do not copy-paste cc-haha tools wholesale — adapt to Reaper's structured-JSON generation model
  (Reaper does NOT use Anthropic native `tool_use` / `defer_loading` / `tool_reference`).
