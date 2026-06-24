# Tier 2 Wave 1 — Reliability + Observability (no behavior change in production)

Date: 2026-06-21
Tier: 2 Wave 1 (items 8, 9, 10)
Mode: IMPLEMENT

## Goal

Lock down the three Tier 2 items that don't require design decisions
from the user, then ship Wave 2 (5, 6, 7) per item after one targeted
question each. Tier 3 stays in a separate conversation with its own
design doc.

## Items in this wave

### T2.9 — Background-process managed lifecycle

**Today**: `tools/executor.ts` calls `attachManagedProcess(entry)`
inline and stores entries in `this.backgroundProcesses` (a
`Map<number, ManagedBackgroundProcess>`). On SIGTERM, the cleanup
registry fires `runCleanupFunctions`, which iterates the map and calls
`treeKill(child.pid, 'SIGTERM')` with a SIGKILL fallback. Manual. No
manifest persistence. If the Reaper process crashes mid-run, children
are orphaned until pid reuse kills them.

**Goal**: Extract a `BackgroundProcessRegistry` that:
- Owns the pid → ManagedBackgroundProcess map
- Owns the manifest file (one JSON per pid under `.reaper_data/runs/<runId>/bg/`)
- Survives Reaper process restart (registry reloads manifest on init)
- Provides a single `terminateAll()` that the cleanup-registry hook calls
- Provides `register()` / `unregister()` / `get()` typed surface

**Files**:
- New: `src/tools/background-process-registry.ts`
- Modify: `src/tools/executor.ts` (replace inline map + attachManagedProcess with registry calls)
- Modify: `src/tools/global/run-shell-command.ts` (no changes — registry wraps the consumer side)
- Modify: `src/runtime/cleanup-registry.ts` (one-line swap to call registry.terminateAll)

**Risks**: reaper_eval has 8.5 GB of historical run logs; on a process
restart with 100+ backgrounded children, the SIGTERM-then-SIGKILL
window means a few seconds of zombie reaping. The registry handles
this with a 2s SIGTERM → SIGKILL escalation matching the existing
inline code.

### T2.10 — Verify-failure regex eval harness

**Today**: `src/verify/failure-classifier.ts` has ~20 regex rules.
Zero telemetry on hit rate. "Did the rule match?" is a binary yes/no
in the trajectory log.

**Goal**: Build `tests/eval/verify-failure-classifier-corpus.ts`:
- 30–50 (stderr, expected_class) pairs sampled from the existing
  `reaper_eval/run_logs/` and `initial_tasks/` failure outputs
- Each pair is a test case that asserts the classifier returns the
  expected class
- If a rule was REMOVED, corpus tests fail (catches accidental rule
  deletions in future PRs)
- If a rule was ADDED, corpus still passes (backward compatible)

The corpus is built from observed Reaper failures — not synthetic.
This is a `tests/eval/` directory that doesn't exist yet; creating it
is in scope. The corpus file is committed to the repo.

**Files**:
- New: `tests/eval/verify-failure-classifier-corpus.test.ts`
- New: `tests/eval/fixtures/verify-failure-corpus.json` (committed corpus)
- Modify: `package.json` test runner glob to include `tests/eval/`

**Risks**: corpus is bounded to what we've seen; it won't catch novel
failures. That's fine — it's a regression net, not a coverage claim.

### T2.8 — Progressive tool disclosure

**Today**: Every model turn's prompt carries every tool description.
With 30+ tools and a 17k-byte registry, this is a significant
context cost on every turn.

**Goal**: Split the registry into two tiers:
- **Always-present (top-12)**: read_file, write_file, replace_in_file,
  edit_file, run_shell_command, grep_search, list_directory, read_file (skim),
  task (todo), web_search, inspect_environment, completion_signal
- **On-demand**: delegate_to_planner, agent, agent_swarm, replace_symbol,
  delete_file, hook_tools (5), extension_tools (6), skill_tools (6),
  browser_control, computer_control, sandbox_service_control,
  activate_skill, web_fetch, plus all MCP tools

The model sees the always-present set plus a `tool_search` tool that
returns the full schema + description for any on-demand tool by name.

**Files**:
- Modify: `src/tools/registry.ts` (add `ON_DEMAND_TOOL_NAMES` export)
- Modify: `src/runtime/engine.ts` content prep node (use the tiered list)
- New: `src/tools/read/tool-search.ts` (the lookup tool itself)
- Wire `tool_search` into the dispatch table in `tools/executor.ts`

**Risks**: changes the prompt every model sees. The behavioral change
is: model must call `tool_search` to discover some tools. If a model
tries an on-demand tool without discovering it first, the existing
unknown-tool guard catches it with a discovery suggestion. So the
fallback path is already in place.

**Default choice** (since you said "lock obvious choices silently"):
I'm picking the top-12 above. They cover ~95% of "I just need to read
or write a file or run a command" tasks. If you'd rather a different
12, say which.

## Out of scope (Wave 2 + Tier 3)

- T2.5 — prompt-injection defense on external content (need design call)
- T2.6 — smart-router telemetry wiring (need design call)
- T2.7 — per-turn token-budget telemetry (need design call)
- Tier 3 — engine.ts decomposition + structural refactors

## Verification

```
npm run typecheck                          # must pass
node scripts/run-node-tests.mjs \
  tests/eval/verify-failure-classifier-corpus.test.ts \
  tests/integration/tools-executor.test.ts \
  tests/integration/runtime-engine.test.ts
npm test                                   # full suite, watch for regressions
```
