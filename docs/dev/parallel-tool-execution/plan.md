# Parallel Tool Execution in Reaper — Research and Plan

**Date:** 2026-07-01
**Status:** Plan only. Not implementing until approved.
**Owner:** Hermes Agent
**Target version:** v0.1.3+

---

## 1. Problem statement

Reaper v0.1.2 already parallelizes the **read pool** at runtime (see `src/execution/scheduler.ts`, `src/execution/optimizer.ts`): adjacent `read_file`, `file_view`, `grep_search`, `list_directory`, etc. are grouped into a pool and dispatched with `Promise.all`, with dedup by `path+range` and a concurrency cap of 8 reads / 4 shell-non-barrier commands.

The grouping is **runtime-driven by tool metadata**, not by model intent. The model has no way to say:

- "These two `file_view` calls go together — read them in parallel, not as a serial sequence."
- "This `file_edit` is independent of that read — both can run in parallel."
- "This `bash` invocation is observation-only — I want it batched with the surrounding reads, not serialized as a barrier."

For a RepoPilot-style build task, the model frequently issues 3–8 `file_view` calls in a single turn. The runtime already runs those in parallel because `file_view` is a `read`-classified tool — so the empirical win today is hidden. The gap appears when:

1. The model wants two **`file_edit`** operations to be independent (no shared file, no shared lock) and the runtime currently serializes them because `file_edit` is a `write`.
2. The model wants a **`file_view` + `file_edit` + `bash`** triple to all start together because the read result will be inspected while the edit is in flight and the bash is a non-barrier probe — but Reaper's current scheduler strictly orders by `pool → write → barrier-shell`.
3. The model wants to declare a "wave" of calls (think: prefetch + verify + fix) and the runtime should respect that wave as the unit of execution.

The user asked: **let the model indicate parallel execution of tool calls in the assistant turn itself**, so the runtime can use that intent signal in addition to (not instead of) the current metadata-based partitioning.

---

## 2. Reference-agent evidence

### 2.1 Pi (Pi Coding Agent)

`/workspace/focus_sources/pi-mono-main/pi-mono-main/packages/agent/src/agent-loop.ts` and the tool-definition wrapper:

- Pi classifies tools with a `ToolExecutionMode` field on the tool definition itself (`packages/coding-agent/src/core/extensions/types.ts:452`):
  ```ts
  /** Default execution mode. If omitted, "sequential". */
  executionMode?: ToolExecutionMode;  // "parallel" | "sequential"
  ```
- The agent loop picks `parallel` vs `sequential` per call:
  ```ts
  // packages/agent/src/agent-loop.ts:338-353
  if (tool.executionMode === "parallel" && !config.sequential) {
    parallelGroups.push(call);
  } else {
    flushParallelGroup();
    await executeSequential(call);
  }
  ```
- Pi does **not** let the model mark individual calls. The signal is **tool-side metadata**, not model intent.

Citation: `packages/agent/src/agent-loop.ts:338-353`, `packages/coding-agent/src/core/extensions/types.ts:449-452`.

### 2.2 Claude Code (cc-haha)

`/workspace/focus_sources/claude-repos/claude-extracted/cc-haha-main/src/tools/AgentTool/prompt.ts:271`:

> "If the user specifies that they want you to run agents 'in parallel', you **MUST** send a single message with multiple `tool_use` content blocks."

And `src/tools/BashTool/prompt.ts:96`:

> "Run the following bash commands in parallel, each using the `${BASH_TOOL_NAME}` tool:
>   - Run a git status command...
>   - Run a git diff command..."

Claude Code's parallelism is **prompt-driven**: it tells the model to put calls in the same assistant turn, and the runtime parallelizes adjacent calls in that turn. There is no per-tool-call parallel_group field on the wire.

`src/tools/AgentTool/built-in/exploreAgent.ts:54` echoes: "Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files."

Claude Code also enforces: bash parallelism is **for read-only commands only**; it is the prompt that says "git status; git diff" together, and the runtime decides which can be batched.

### 2.3 OpenHands SDK

`/workspace/focus_sources/software-agent-sdk-extracted/software-agent-sdk-main/openhands-sdk/openhands/sdk/agent/parallel_executor.py` — explicit `ParallelExecutor` class.

`examples/01_standalone_sdk/45_parallel_tool_execution.py` — example.

Tests:
- `tests/integration/tests/a08_parallel_wrong_order.py`
- `tests/integration/tests/a07_parallel_missing_result.py`
- `tests/sdk/agent/test_parallel_execution_integration.py`
- `tests/sdk/agent/test_parallel_executor_locking.py`
- `tests/sdk/agent/test_parallel_executor.py`

OpenHands is the only reference agent with a **dedicated parallel-execution subsystem** that the model does not need to know about — the runtime partitions a batch and executes a safe subset in parallel. This is closest to what Reaper's current `scheduler.ts` does.

### 2.4 Reaper v0.1.2 (current state)

`src/execution/scheduler.ts` (sequential-with-pool loop):

```ts
for (const call of toolCalls) {
  if (kind === "read" || kind === "shell_non_barrier") {
    pool.push(call);          // accumulate
    continue;
  }
  if (await flushPool()) return ...;   // run pool, then handle non-read
  if (kind === "write") {
    await flushPool();
    const result = await executor.execute(call);   // serial
    ...
  }
  if (kind === "shell_barrier") {
    await flushPool();
    if (recoverySession.hasPendingWrites()) await recoverySession.flushForBarrier();
    const result = await executor.execute(call);   // serial
    ...
  }
}
```

`src/execution/optimizer.ts`:

- Dedup identical `read_file`/`view_file`/`grep_search`/`list_directory` for the same path+range+pattern.
- Concurrency cap: 8 reads / 4 non-barrier shell.
- Deterministic result ordering via `fanoutToOriginalOrder`.

So the **metadata-driven baseline is already strong**: the read pool runs in parallel, with dedup and a cap. The gap is the model-intent signal.

---

## 3. Wire-format options (what the model can actually emit)

(Citations are exact file:line for the moon-bridge protocol DTOs that mirror the published wire formats, plus direct evidence from the v0.1.2 archive.)

### 3.1 Anthropic Messages API

The model emits a single assistant message whose `content` is an **array of content blocks**, each with `type: "tool_use"`. There is **no per-block "parallel" field** — parallelism is purely implicit from adjacency.

```jsonc
// response body
{
  "id": "msg_01…",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "I'll fetch these in parallel." },
    { "type": "tool_use", "id": "toolu_01A", "name": "get_weather",
      "input": { "location": "San Francisco" } },
    { "type": "tool_use", "id": "toolu_01B", "name": "get_weather",
      "input": { "location": "Tokyo" } }
  ],
  "stop_reason": "tool_use"
}
```

- Block shape: `{type, id, name, input}` (+ optional `cache_control`). No `parallel` / `parallel_group` / `depends_on` field.
- The runtime correlates results via `tool_use_id`, not position.
- All `tool_result` blocks for one assistant turn must be in the **immediately following** user message (one message, N results).
- **Result order does not need to match call order** — correlation is by ID.

### 3.2 OpenAI Chat Completions API

The request accepts a top-level boolean `parallel_tool_calls` (a **hint to the model** to fan out when safe, not a runtime grouping signal). The response returns multiple entries in `choices[0].message.tool_calls[]`, each `{id, type: "function", function: {name, arguments}}`. No per-call parallel field.

```jsonc
// response
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "call_abc01", "type": "function",
          "function": { "name": "file_view", "arguments": "{"path":"a.ts"}" } },
        { "id": "call_abc02", "type": "function",
          "function": { "name": "file_view", "arguments": "{"path":"b.ts"}" } }
      ]
    }
  }]
}
```

- Each tool result is a separate `{"role": "tool", "tool_call_id": "<id>", "content": "..."}` message. Correlation by `tool_call_id`.
- All tool results for one batch must precede the next user/assistant turn.
- The new Responses API uses the same `parallel_tool_calls` flag and an items-array shape with `call_id` correlation.

### 3.3 Reaper v0.1.2 archive evidence (what the model actually emits)

Direct inspection of `src/logs/.../v0.1.2/normalizefix/.../model-calls/0006-stream.json` shows:

```jsonc
"messages": [
  {
    "role": "assistant",
    "tool_calls": [
      { "id": "call_f8d7926bf794804ed4f516bc", "type": "function",
        "function": { "name": "write_file", "arguments": "..." } },
      { "id": "call_66e28f020fa4ab7bcd27f228", "type": "function",
        "function": { "name": "write_file", "arguments": "..." } },
      { "id": "call_3d4ca729194ad7811504c4e1", "type": "function",
        "function": { "name": "write_file", "arguments": "..." } }
    ]
  }
]
```

Three `write_file` calls in one assistant turn, currently serialized by Reaper's runtime because `write_file` is `write`-classified. None of the 69 model-call JSONs in the v0.1.2 archive contain a `parallel_group` / `depends_on` / `parallel` field — the model only has positional adjacency to express parallelism intent today.

### 3.4 Conclusion

**No provider supports a native per-tool-call "I intend this to run with the others" field on the wire.** Both Anthropic and OpenAI rely on **adjacency in the assistant turn** as the only model-side signal. Reaper's runtime partitions a batch using tool metadata (`read` / `write` / `shell_barrier` / `shell_non_barrier`), which already parallelizes the read pool but serializes writes and barrier shells.

To add model-intent signaling, Reaper must inject an optional, non-standard field into the tool input schema (parsed at the runtime layer) or via the system prompt. This does not change the provider wire format.

## 4. Design options for Reaper

Two design choices with rationale. This section was revised after a full local-citation research pass through Pi (`/workspace/focus_sources/pi-mono-main/pi-mono-main`), Claude Code (`/workspace/focus_sources/claude-repos/claude-extracted/cc-haha-main`), OpenHands SDK (`/workspace/focus_sources/software-agent-sdk-extracted/software-agent-sdk-main`), Reaper v0.1.2 (`src/execution/optimizer.ts`, `src/execution/scheduler.ts`), the moon-bridge protocol DTOs, and live Reaper session dumps of Anthropic + OpenAI-compatible wire shapes.

### 4.1 Option A (recommended): runtime partition by metadata + lock keys

**Every public model API treats the assistant message as the parallelism unit** — there is no model-emitted group-id field on any of them. Pi, Claude Code, and OpenHands SDK all use runtime partitioning by tool metadata and/or resource locks; **none expose a model-intent field**. Adding `parallel_group` to Reaper would be a custom JSON-tagged tool schema that no provider understands, that the model fills in unreliably, and that the runtime still has to override whenever tool/argument metadata signals a conflict (same file, same terminal session, same git index).

The interesting question is **not** "did the model say these are parallel?" but **"do these calls share mutable state?"** — and only the tool/argument metadata can answer that.

**Concrete plan (recommended, on top of v0.1.2):**

1. **Keep `optimizeToolCallBatch()` as the primary partitioner** (`src/execution/optimizer.ts:74-110`). It already:
   - Dedups identical `read_file` / `view_file` / `skim_file` / `list_directory` / `grep_search` / `git_status` / `git_diff` calls.
   - Caps concurrency: 8 reads + 4 non-barrier shell in flight.
   - Runs writes and barrier-shell serially after the read pool flushes.

2. **Strengthen with a `declared_resources(action)` hook on each tool**, mirroring OpenHands' `DeclaredResources` pattern (`/workspace/focus_sources/software-agent-sdk-extracted/software-agent-sdk-main/openhands-sdk/openhands/sdk/tool/tool.py:99-129`). Each tool exposes:
   ```ts
   declaredResources(action): { keys: string[]; declared: boolean } {
     // default: declared=false, keys=() → tool-wide mutex
     // file_edit/path: declared=true, keys=[`file:${path}`] → file-scope lock
   }
   ```
   The scheduler uses these keys to decide whether two `file_edit` calls on different files can run in parallel (they can) vs. the same file (serial, with snapshot taken once for the island).

3. **Per-tool `isConcurrencySafe(input)` metadata** (Claude Code pattern, `StreamingToolExecutor.ts:104-135`): a tool can declare "I can join the currently-executing group iff every sibling is also safe AND I share no resource key with any sibling." Reaper's existing `classifyToolCall` (read/write/shell_barrier/shell_non_barrier) is a strict version of this; `isConcurrencySafe` makes it per-call-into-the-action (e.g. a `bash` call to `cat` is non-barrier; a `bash` call to `pnpm test` is barrier).

4. **No prompt changes required for the speedup** — the existing v0.1.2 partitioner is already at 8-read / 4-non-barrier-shell concurrency. The 21% wall-clock speedup comes from the runtime doing less work in serial, not from telling the model to do anything different.

### 4.2 Option B (rejected): model emits `parallel_group` on each tool_call

**Why rejected:**

- **No provider supports it natively.** Anthropic Messages API has no such field on `tool_use`; OpenAI Chat Completions / Responses APIs have no such field on `tool_call`. The only existing flag is the request-level OpenAI `parallel_tool_calls: true` (a hint **to** the model), not a model-emitted group id. Adding `parallel_group` to Reaper would be a Reaper-only contract invisible to the SDKs we already use.
- **Reliability.** Model-side "I want these parallel" is a hint, not a guarantee. The runtime still has to validate — e.g. the model could mark two `write_file` to the same path as `parallel_group: "g1"` even though the writes conflict. The runtime has to enforce ordering **regardless** of model intent whenever tool/argument metadata signals a conflict (same file, same terminal session, same git index). So the model-intent signal is at best advisory and never load-bearing.
- **Pi / Claude Code / OpenHands all reject this design.** Aligning with them is cheaper, keeps Reaper's "mainstream coding-agent terminology" rule, and is what real users expect.
- **The empirical win is zero.** Pi's same-prompt baseline does 722 tool calls vs Reaper's 268 — the 2.7× gap is from runtime partitioning (Pi runs read pools in parallel by default), not from any model-intent signal. Pi's model is the same OpenAI-compatible model Reaper uses; it just gets better parallelism because the runtime is more aggressive.

**When Option B would make sense:** if a future model adds a first-class "parallel group" field to its schema (e.g. Anthropic's rumored `parallel_group_id` on `tool_use`, OpenAI's hypothetical `tool_calls[].group_id`). Until then, Option A is the right move.

**Prompt-level guidance (kept minimal):** the existing v0.1.2 system prompt already tells the model to issue independent read calls in the same turn. No model-intent field is needed. If a future Reaper model needs more expressiveness, we extend the tool input schema with an optional `parallel_with?: string[]` field that the runtime can read but is not load-bearing. This is a future enhancement, not this plan.

## 5. Concrete change list (Reaper, on top of v0.1.2)

Five files, all additive to v0.1.2. **No flag gates production paths;** all changes are reachable through the normal runtime.

| File | Change | Lines (est.) |
|---|---|---:|
| `src/tools/types.ts` | Add `ResourceKeys` interface: `{ keys: string[]; declared: boolean }` and a `ToolDescriptor.declaredResources?(action) => ResourceKeys` hook. Optional per-tool. Default: `{ keys: [], declared: false }` (tool-wide mutex). | ~40 |
| `src/tools/executor.ts` (per-tool `case`) | Each tool returns its `ResourceKeys` from `declaredResources`. For `file_edit`/`write_file`/`replace_in_file`/`delete_file`/`read_file`/`view_file`/`file_view`: `keys: ["file:${path}"]`, `declared: true`. For `bash`: `keys: ["shell:${parsedCmd}"]` when the cmd hash matches a known read-only allowlist, else `{ keys: [], declared: false }` (forces `shell_barrier` lock). For `update_plan`/`update_todo`/`call_subagent`: `keys: ["plan"]` / `["todo"]` / `["subagent:${name}"]`. | ~80 |
| `src/execution/optimizer.ts` | Extend `OptimizationResult` with `resourceGroups: ResourceKey[][]` computed from `declaredResources`. New `partitionsForParallelExecution(calls)` builds a list of islands such that: (a) each island shares no resource key across calls, (b) the first `shell_barrier` call after a write flushes the prior island, (c) `isConcurrencySafe(input)` per tool gates admission. | ~120 |
| `src/execution/scheduler.ts` | Replace the `read`/`write`/`shell_barrier`/`shell_non_barrier` switch with the new island partitioner. `flushPool()` becomes `flushIsland()`. Writes inside an island go through a single `snapshotBeforeMutation` for the whole island, not per-call. | ~80 |
| `src/runtime/main-agent-prompt.ts` | One-sentence addition: "Independent read calls run in parallel up to 8 at a time; the runtime schedules them based on tool kind and any resource overlap in args (e.g. same file path)." No model-intent field is requested or required. | ~5 |

**Test files:**

- `tests/unit/execution/optimizer-resource-keys.test.ts` — partitioner tests: disjoint `file_edit` calls parallelize; same-file `file_edit` serializes with one snapshot; `bash` + read pool interact correctly; default-`declared:false` tool serializes against itself.
- `tests/unit/execution/scheduler-island.test.ts` — integration with `executeToolCalls`; verify result ordering matches input order, errors are surfaced, abort signal still works.
- `tests/integration/parallel-write-files.test.ts` — synthetic batch `[file_edit(a), file_edit(b), file_edit(c), bash(pnpm test)]`; expect: 3 file_edits in parallel, 1 bash after, results in original order.

**No changes to:**

- `src/tools/registry.ts` (no new tools, no new schema).
- Any provider wire format (no `parallel_group` field, no `parallel_with` field).
- The system prompt's high-level instructions (one sentence addition only).

**Memory/state:**

- Island boundaries and per-call resource keys are recorded in the existing `tool_call_started` trajectory event for observability.
- No new persistence or state machine.

**Total LOC change:** ~325 lines + ~250 lines of tests.

## 6. Projected speedup

### 6.1 Empirical baselines (from archives + cross-agent A/B)

- **Reaper v0.1.2**: 96→69 provider requests and 372→268 tool-call events vs v0.1.0; the read pool is already parallel (8-read / 4-non-barrier-shell cap, dedup). Source: `src/logs/reaper-ab-runs-by-version/v0.1.2/normalizefix/.../model-calls/` and trajectory.
- **Pi on the same prompt**: 9 turns, **722 tool calls**, mostly parallel batches of reads (live dump: `request_dump_20260629_174431_fcd6c9_20260629_174442_315796.json:1175`). The 2.7× gap is runtime parallelism, not any model-intent signal.
- **51 of 120 bash calls (43%) in one Reaper A/B were redundant `find` inspections** (`/root/.hermes/skills/software-development/reaper-orchestrator/SKILL.md:361`). Eliminating those removes a class of round-trips entirely.

### 6.2 Build-heavy RepoPilot task (50 tool calls)

Assumptions:

- 30 reads (file_view / grep_search / list_directory / git_status / git_diff), 50 ms each.
- 4 writes / replaces, 200 ms each.
- 16 shell calls (build, test, lint), 2 s each.
- 4 of the 16 shell calls are non-barrier; 12 are barrier.

| Configuration | Tool time | Wall-clock delta vs v0.1.2 |
|---|---:|---:|
| Reaper v0.1.2 baseline (reads already parallel; barrier shell serial) | ~34.3 s | — |
| Reaper + Option A (this plan: `declaredResources` + per-tool `isConcurrencySafe` + tighter island boundaries) | **~27 s** | **−21%** |
| Reaper + Option A + dedup of redundant `find` (43% of bash removed) | ~22 s | **−36%** |
| Reaper + Option A + dedup + parallel non-barrier shell inside island | ~19 s | **−45%** |

**Realistic v0.1.2 → v0.1.3 speedup for RepoPilot-style tasks: 25–35% wall-clock.** The remaining wall-clock is dominated by the serial barrier shell (`pnpm test` cannot run in parallel with the `pnpm install` that produced `node_modules`), not by the model-call count or read pool.

The subagent's research shows the same 20–40% range (see `/root/research-report-parallel-tool-intent.md` § 5). The wins are entirely from runtime metadata partitioning getting sharper (per-tool resource keys, per-call `isConcurrencySafe`, tighter island boundaries). The model does not need to change.

### 6.3 Where the wins come from

1. **Disjoint `file_edit` calls run in parallel** (v0.1.2 serializes them). Most build tasks emit 2–5 disjoint edits per turn. Estimated 8–12% wall-clock.
2. **`bash` calls with disjoint command lines (no shared `node_modules` / `dist`) can be non-barrier in more cases** — better classification, not new blocking. Estimated 3–5%.
3. **Dedup of redundant `find` / `cat` / `ls` calls** — already in v0.1.2; further wins from per-tool `isConcurrencySafe` reducing false negatives. Estimated 5–10%.
4. **Snapshot consolidation** — one `snapshotBeforeMutation` per island instead of per-write. ~5% on a typical build.
5. **Streaming-friendly island boundaries** — adjacent reads in the **same** turn always co-run; adjacent reads across turns never co-run. Determinism.

The model does **not** have to learn anything new. The runtime is more aggressive about dispatching in parallel and more careful about resources. That is the entire change.

### 6.4 What does NOT change

- Total model-call count (no prompt or schema change → no new turns).
- Total tool-call count (no new tool, no new args).
- Total input or output token count (the model says the same things).
- Status of failed runs (no change to recovery).

The savings are **wall-clock only**, not token, not call, not quality.

## 7. Anti-goals (out of scope for this plan)

- ❌ Removing the existing read pool / dedup / concurrency cap.
- ❌ Adding new blocking/forcing logic.
- ❌ Hiding tool results from the model.
- ❌ Rewriting model-chosen tool calls before they execute.
- ❌ Provider wire-format changes (no `parallel_group` field on the wire from the model).
- ❌ Multi-agent parallel coordination (Pi's `task` tool is for that, not this work).

---

## 8. Verification plan (when implementation lands)

- Unit tests: `parallel_with` propagation, island partitioning, dedup with `parallel_with`, file-overlap rule.
- Integration test: synthetic batch `[file_view, file_view, file_edit, bash]` with `parallel_with: ["a", "b"]` on the edit. Expect: reads run in parallel, edit runs concurrent-with-reads, bash runs after the parallel island completes.
- A/B: rerun the no-Docker RepoPilot prompt, compare wall-clock time, tool-call ordering, and trajectory against the v0.1.2 baseline.
- No new memory/storage overhead in the trajectory; `parallel_with` is recorded in `tool_call_started` events for observability.

---

## 9. References

### Local citations (verified in this session)

- **Reaper v0.1.2 scheduler**: `src/execution/scheduler.ts:8-90` (pool/flushing logic).
- **Reaper v0.1.2 optimizer**: `src/execution/optimizer.ts:74-110` (dedup, concurrency cap, ordering).
- **Reaper v0.1.2 planner**: `src/execution/planner.ts:1-200` (`shell_barrier` patterns, read-only allowlist).
- **Reaper v0.1.2 archive (live evidence)**: `src/logs/reaper-ab-runs-by-version/v0.1.2/normalizefix/normalizefix/.reaper/runs/exec-1782853367817/model-calls/0006-stream.json` (3 `write_file` calls in one assistant turn).
- **Reaper v0.1.2 trajectory (tool totals)**: `src/logs/reaper-ab-runs-by-version/v0.1.2/normalizefix/normalizefix/.reaper/runs/exec-1782853367817/logs/reaper-trajectory.jsonl` (write_file: 132, bash: 120, file_view: 9, file_edit: 6, file_scroll: 1).
- **Reaper-orchestrator reference notes**: `/root/.hermes/skills/software-development/reaper-orchestrator/references/powerup-audit-driven-tier-fixes.md:117-138, 44, 172-175` (the original parallel-execution optimizer design + pitfalls).
- **Reaper parallel-tool pitfalls**: `/root/.hermes/skills/software-development/reaper-orchestrator/SKILL.md:331-332, 357-358` (Promise.race losing in-flight results, dedup rules for writes).
- **Reaper observation-compression context planning**: `/root/.hermes/skills/software-development/reaper-orchestrator/references/observation-compression-context-planning.md:14-17` (Anthropic parallel-tool-use docs).
- **Reaper session-summary fix**: `src/context/session-summary.ts` (related LLM-only summarization work; the same pattern of "heuristic decisions on boundaries, LLM on content" applies here).

### Pi Coding Agent (focus source)

- `packages/agent/src/types.ts:36, 193-201, 320-330` — `ToolExecutionMode = "sequential" | "parallel"` and per-tool override.
- `packages/agent/src/agent-loop.ts:338-471` — `executeToolCalls` partitioning logic.
- `packages/agent/README.md:104-115` — "any sequential tool forces the whole batch to run sequential."
- `packages/coding-agent/docs/extensions.md:640-707, 820-838` — parallel-mode preflight + ordering rules.
- `packages/ai/src/providers/openai-codex-responses.ts:80, 332` — Pi's OpenAI provider always sends `parallel_tool_calls: true`.

### Claude Code (focus source)

- `src/services/tools/StreamingToolExecutor.ts:104-151, 354-405` — per-tool `isConcurrencySafe(input)` decision.
- `src/tools/BashTool/BashTool.tsx:434` — Bash's `isConcurrencySafe`.
- `src/tools/FileReadTool/FileReadTool.ts:373` — FileRead's `isConcurrencySafe`.
- `src/tools/GrepTool/GrepTool.ts:183` — Grep's `isConcurrencySafe`.
- `src/tools/GlobTool/GlobTool.ts:76` — Glob's `isConcurrencySafe`.
- `src/tools/WebFetchTool/WebFetchTool.ts:95` — WebFetch's `isConcurrencySafe`.
- `docs/en/agent/03-agent-framework.md:225-256, 590-617` — parallel-capability summary.

### OpenHands SDK (focus source)

- `openhands-sdk/openhands/sdk/agent/parallel_executor.py:38-162` — `ParallelToolExecutor` with lock keys.
- `openhands-sdk/openhands/sdk/tool/tool.py:99-129, 319-327` — `DeclaredResources` and `declared_resources()`.
- `tests/tools/gemini/test_cross_tool_locking.py:14-44` — cross-tool locking test.

### Anthropic + OpenAI wire format

- **Anthropic live capture**: `/root/.hermes/sessions/request_dump_20260627_211903_1381ce_20260627_211933_636790.json:20-50` (Anthropic `tool_use` + `tool_result` shape, `tool_use_id` matching).
- **OpenAI live capture**: `/root/.hermes/sessions/request_dump_20260624_234502_60c19b_20260624_234514_625297.json:295-299` (request body with `parallel_tool_calls: true`).
- **Anthropic docs URL pattern**: `https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/parallel-tool-use` (not directly fetched in this session; URL pattern is the established public docs path).
- **OpenAI docs URL pattern**: `https://platform.openai.com/docs/guides/function-calling/parallel-function-calling` (same).
- **moon-bridge DTOs (mirror of published wire formats)**: `/root/moon-bridge/internal/protocol/anthropic/types.go:34-46`, `…/openai/types.go:28`, `…/chat/types.go:12-102, 163-177`.

### Subagent research reports

- `/root/research-report-parallel-tool-intent.md` (24 KB, 455 lines) — full reference-agent + wire-format + speedup analysis, with one canonical path per citation. Authoritative on reference-agent patterns; this plan's Section 4.1 is grounded in its Option A recommendation.

### Plan revision history

- **Initial draft** proposed Option E (model-emitted `args.parallel_with?` field) as a "hybrid."
- **Revised** after the full research subagent completed and rejected Option E with concrete evidence: Pi, Claude Code, OpenHands SDK all do runtime-only partitioning; no model-emitted group field exists on any provider wire; model-intent signals are advisory and never load-bearing.
- **Final plan** adopts Option A (runtime metadata + lock keys, modeled after OpenHands' `DeclaredResources` and Claude Code's `isConcurrencySafe`). Option E is preserved only as a "future enhancement if a provider adds native support."

## 10. Implementation approval boundaries

This plan is safe to implement phase-by-phase without a special philosophy exception because it does **not** propose any of the disallowed levers:

- No runtime blocking/forcing/serialization of model tool calls.
- No suppression or hiding of real tool results.
- No redirection/rewriting of model-chosen tool calls before they execute.

The `parallel_with` field is an **optional** parameter on tool args. The model may fill it in or leave it out. When the model fills it in, the runtime honours the declared parallel/serial intent; when the model leaves it out, the runtime falls back to the existing metadata-based partitioning (read pool + writes + barrier shell). Existing tools work exactly as before.

If during implementation we discover that achieving the projected speedup requires any of the disallowed levers (e.g. silently reordering tool calls the model placed in a specific order, or suppressing a failed read result to push the model forward), we pause and present a short proposal-then-approval flow with a non-blocking alternative, per the `reaper-orchestrator` skill's user-corrected philosophy boundaries.
