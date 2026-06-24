# Tier 3 — engine.ts decomposition plan

Date: 2026-06-21
Mode: SHIP (per AGENTS.md — structural refactor with parity required)
Target file: `src/runtime/engine.ts` (12,183 LOC, 758 functions, 80+ imports)

## Why we're doing this

`engine.ts` was flagged in the original Reaper audit as the single
biggest concentration of risk in the codebase. It owns:
- The LangGraph StateGraph node definitions and transitions
- The content-prep node (file index, history compaction, fingerprinting)
- The agent_step and rescue-watchdog flows
- The relevance gate (chunk-level relevance scoring before sending to model)
- The diagnostic-target detection (which file path is the patcher
  editing)
- All 11 model call sites' prompt builders
- The trajectory / audit / langfuse logging wiring
- The recovery session integration (WAL, checkpoint, rollback)
- The completion-gate logic
- The orchestrator (best-of-N, planner subagent, patcher subagent)
- The TUI-driven turn loop bootstrap

A single change anywhere in this file carries high blast radius.
The mitigation has been "careful edits" — works, but doesn't scale.
The remediation is to extract self-contained submodules behind
gated imports so engine.ts becomes the orchestrator and the
extracted modules own their domains.

## Decomposition order (smallest blast radius first)

### Wave 1 — Pure functions, no engine state (NO parity run needed)

These extractions move pure helpers and free functions into
sibling modules. They're tested in isolation; engine.ts just
imports them.

**1a. `rescue-watchdog.ts`** (already planned) — ~320 LOC
- `makeRescueWatchdogSignature`
- `isMeaningfulRescueProgressResult`
- `buildSyntheticPatchRequestSignal`
- `getRescueDiagnostic`
- Detection helpers used by the rescue flow.
- All pure functions; extraction is mechanical.

**1b. `diagnostic-target.ts`** — ~160 LOC
- Detect which file path a failed step is targeting.
- Pure functions over tool results.

**1c. `relevance-gate.ts`** — ~1000 LOC
- Chunk-level relevance scoring + filtering.
- Largest Wave 1 module but still self-contained.
- Touches: content prep's `preparedContext.chunks`.

### Wave 2 — Free functions with side effects on input-only data

These extractions move prompt builders that take `input` arguments
and return strings. No state mutation outside their function scope.

**2a. `prompts/simple-executor.ts`** — `buildSimpleExecutorPrompt`
**2b. `prompts/repair.ts`** — repair-prompt builder
**2c. `prompts/summarize.ts`** — `generateFinalSummary` (already a
free function, just move it).
**2d. `prompts/planner.ts`** — planner subagent prompt
**2e. `prompts/patcher.ts`** — patcher subagent prompt

### Wave 3 — Engine-state helpers

These extractions move functions that read or mutate engine-owned
state (the `RuntimeEngine` instance fields). They become methods on
a separate class that takes the engine instance via constructor
injection, or pure functions that take the relevant state as args.

**3a. `runtime-state.ts`** — Boot, getBoot, getRequest, getAuditLogger,
getExecutor — all the engine-state accessors. Move into a small
`RuntimeState` class.

**3b. `turn-events.ts`** — `makeEvent`, `splitControlToolCalls`,
`renderPatchRequestFeedback` — pure transforms over events.

### Wave 4 — Sub-agent call sites (highest blast radius)

The `callPlannerSubagentTool` and `callPatcherSubagentTool` free
functions are large and tightly coupled to the engine. They move
into `src/runtime/subagents/` with their helpers.

### Wave 5 — Engine node bodies (gated by parity run)

The LangGraph StateGraph node functions (content_prep_node,
simple_executor_node, repair_autonomous_node, etc.) move into
sibling modules. Each becomes a top-level function that takes the
node input + an `EngineContext` argument. **This wave requires the
parity run** because the node bodies share state via the boot
closure.

## Parity run (Wave 5+)

`reaper_eval` runs a fixed battery of coding tasks on a fixed set
of workspaces, scoring success rate + token usage. The parity
procedure:

1. Tag the current commit as `pre-t3-11-baseline`.
2. Run `reaper_eval` (the workspaces under
   `/workspace/reaper_eval/workspaces/`). Record per-task
   pass/fail + tool-call count + token count.
3. Apply the extractions.
4. Re-run `reaper_eval` from the same baseline inputs.
5. Pass criterion: every task that passed pre-extraction also
   passes post-extraction. Token/tool-call count within ±5%.
6. If any task regresses: do NOT proceed; back out the failing
   extraction and investigate.

The parity run is gated by the `REAPER_ENGINE_V2=1` env flag so
operators can opt in or out without code changes.

## What's out of scope (deferred)

- Decomposing the LangGraph StateGraph definition itself. It's a
  built-in LangChain primitive and not worth abstracting.
- Moving the TUI integration. TUI lives in its own directory;
  already self-contained.
- Moving the best-of-N rollout logic. Uses a child RuntimeEngine
  instance; that recursive pattern is intentional and shouldn't
  be flattened.

## Risks

- **Circular imports**: the engine has 80+ imports. Wave 3+ might
  create import cycles. Mitigate by extracting types to a separate
  `engine-types.ts` file consumed by both engine and extracted
  modules.
- **Behavior drift**: Wave 5 touches the run-loop. The parity run
  catches it; we will not ship a Wave 5 change without parity.
- **Test coverage gaps**: reaper_eval covers happy paths but not
  every error path in the engine. For Wave 5, supplement with
  per-extraction unit tests.

## Current status

- [x] Wave 1a (rescue-watchdog) — extraction in this turn.
- [ ] Wave 1b–1c — next.
- [ ] Wave 2a–2e — following.
- [ ] Wave 3a–3b — later.
- [ ] Wave 4 — gated on Wave 3.
- [ ] Wave 5 — gated on parity run.
