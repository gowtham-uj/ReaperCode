# Reaper Sub-Agent Inventory

This document is the user-facing view of every sub-agent currently wired into the
Reaper runtime. It is intentionally exhaustive — name, file, prompt source,
model role, when it fires, what it produces — so you can answer "what is X, who
calls it, and what does it do" without grepping the repo.

If a sub-agent's contract changes, update this file in the same commit.

> **Refactor status (2026-06):** Two refactors landed in the same window:
>
> 1. The runtime was reshaped so the main engine is the only agent that emits
>    tool calls. The legacy `planner_subagent`, `replanner_subagent`,
>    `patcher_subagent`, `judge`, `repair_autonomous`, and the
>    `request_patch` / `delegate_to_plan` tool-sub-agents are all gone.
>    The one planning sub-agent left is the **unified Planner**, which the
>    main model calls via the `delegate_to_planner` tool with one of three
>    modes. The `completion_gate` is no longer a sub-agent — it is pure
>    control flow. The `step_executor_subagent` is no longer a separate
>    concept — the main model *is* the executor.
>
> 2. The hardcoded 7-role `SwarmOrchestrator` (scout / architect /
>    implementer / test / reviewer / critic / debugger) was deleted in
>    favor of a **model-driven parallel fan-out**. The main model
>    calls the new `agent_swarm` tool with a `prompt_template`
>    containing `{{item}}` and an `items` list; the runtime launches
>    one focused subagent per item in parallel (bounded by
>    `max_concurrency`), and returns a single consolidated
>    `<agent_swarm_result>` block. The main model decides when to
>    fan out — there is no engine-side swarm decision gate.

---

## 1. The three layers

Reaper has three distinct kinds of sub-agents:

| Layer | Triggered by | Discoverable by the main agent? | Examples |
|---|---|---|---|
| **Engine-internal sub-agents** | Hard-wired into `RuntimeEngine` graph nodes. | No — they fire on engine state, not on a model tool call. | `summarizer` |
| **Tool-sub-agents** | The main model emits a `tool_use` block. | Yes — they appear in the main agent's tool list, just like `write_file` or `run_shell_command`. | `delegate_to_planner` (with `mode="initial" \| "replan" \| "update_todo"`), `agent`, `agent_swarm`, `activate_skill`, `advance_step` |

The main engine is itself a sub-agent of the CLI / REPL, but we don't count
that here — `RuntimeEngine` is the host, not a sub-agent of itself.

### The model in one sentence

> **The main engine is the only agent that runs the main loop. The
> Planner is the only planning sub-agent, called by name via
> `delegate_to_planner`. Parallel work is dispatched by the main model
> via the `agent` / `agent_swarm` tools — the runtime does not
> auto-fan-out. Everything else is either a tool, a skill, or
> plain control flow.**

---

## 2. Engine-internal sub-agents

These live inside `src/runtime/engine.ts` and fire automatically based on
engine state. The main model never sees them as tools.

### 2.1 `summarizer` (final summary)

| | |
|---|---|
| **File** | `src/runtime/engine.ts` (the `summarize` node) |
| **Schema / prompts** | inline in `engine.ts`; `generateFinalSummary` |
| **Model role** | `summarizer` |
| **Fires when** | The engine transitions to the `summarize` node. That happens when the main model emits `complete_task`, or emits no executable tool calls, or the engine's shell-based completion verification succeeded. |
| **Input** | The trajectory so far: tool results, file diffs, verification outputs, the `complete_task` summary. |
| **Output** | A short prose summary suitable for the human user. Written to the trajectory and surfaced as the run's final assistant message. |
| **Failure mode** | Falls back to a templated summary if the model call fails. |

The summarizer is the only remaining engine-internal model call on the
main hot path. It runs exactly once per task.

### 2.2 What used to be here (deleted)

The following sub-agents were **deleted** in the 2026-06 refactor. They are
listed here only so future readers can map old trajectory events or test
expectations to the new architecture.

- **`planner_subagent` / `replanner_subagent`** — replaced by the unified
  Planner (see §4.1). The main model calls it via `delegate_to_planner`.
  The engine no longer auto-invokes a planner on run start.
- **`patcher_subagent`** — when a tool call fails, the error is returned
  to the main model in the next turn. The main model decides what to try
  next (fix, retry, or call `delegate_to_planner(mode="replan")`).
- **`judge` (verification judge)** — the engine no longer invokes a judge
  model. Verification is the main model's responsibility (it must run a
  real check before `complete_task`). The shell-based completion
  verification still runs and gates `complete_task` admission.
- **`step_executor_subagent`** — the main model *is* the executor. The
  per-step `dispatchStepNode` model call is now just "the main model
  emits tool calls for the current step".
- **`repair_autonomous`** — the engine no longer runs an inline
  self-repair loop. The main model retries naturally on the next turn.
- **`completion_gate` (the model call)** — refactored to pure control
  flow. The engine routes the main model to `summarize` when it emits
  `complete_task` or emits no executable tool calls. The shell-based
  `runCompletionVerification` still fires before `summarize` but is not
  a sub-agent.
- **`SwarmOrchestrator` + 7-role ensemble** (scout / architect /
  implementer / test / reviewer / critic / debugger) — replaced by the
  `agent_swarm` tool (see §4.3). The engine no longer
  auto-decides when to fan out; the main model picks `agent` /
  `agent_swarm` per turn.

---

## 3. Swarm sub-agents (`src/adaptive/swarm/`) — model-driven

The hardcoded 7-role `SwarmOrchestrator` is gone. The runtime now
exposes two model-driven tools — `agent` (single subagent) and
`agent_swarm` (parallel fan-out via `{{item}}` template) — and the
main model decides when to use them. This section documents the
runtime that powers those tools.

### 3.1 Architecture

| | |
|---|---|
| **Module** | `src/adaptive/swarm/` |
| **Subagent store** | `SubagentStore` — persists each subagent's launch spec, wire events, prompt snapshot, and output under `<workspace>/.reaper/swarm/<agentId>/`. |
| **Labor market** | `LaborMarket` — YAML-defined allowlist of subagent types (`coder`, `explore`, `plan`, ...). Each type carries a description, default model, tool policy, and `system_prompt_addition`. |
| **Single runner** | `ForegroundSubagentRunner` — runs one subagent end-to-end: prepare soul, drive the model call loop, summarize on completion, persist transcript. |
| **Tool wrappers** | `AgentTool` (single) and `AgentSwarmTool` (parallel fan-out) — thin adapters that surface the runner as a tool call. |
| **Wiring** | `agent_swarm` is registered in the engine's `toolRegistry` and in `CORE_TOOL_NAMES` so the main model sees the full schema on every turn. |

### 3.2 Built-in subagent types (from `LaborMarket`)

| Type | Default profile | When to use |
|---|---|---|
| `coder` | full read/write/test/command; excludes `Agent` and `AskUserQuestion` | non-trivial engineering work that needs its own context |
| `explore` | read-only allowlist | fast codebase exploration; launch several in parallel for independent questions |
| `plan` | read-only | focused sub-plans and architecture analysis |

The exact allowlist is in the YAML files under
`src/adaptive/swarm/builtin-types/` and is loaded at runtime by
`LaborMarket`. A subagent cannot spawn further subagents: the
`Agent` / `AskUserQuestion` tools are excluded by default in the coder
profile, and any custom profile should do the same.

### 3.3 What the main model sees vs. what the runtime sees

- The main model only sees the formatted summary / `<agent_swarm_result>`
  block. It never sees the subagent's intermediate tool calls, scratchpad,
  or context window.
- The subagent's full transcript is persisted under
  `<workspace>/.reaper/swarm/<agentId>/output.md` and the prompt snapshot
  under `<workspace>/.reaper/swarm/<agentId>/prompt.md`. These are
  useful for debugging and for resuming a subagent.

---

## 4. Tool-sub-agents (the main agent CAN call these)

These appear in the main model's tool list. The main model emits
`tool_use` blocks to invoke them.

### 4.1 `delegate_to_planner` (the unified Planner)

| | |
|---|---|
| **File** | `src/tools/write/delegate-to-planner.ts` |
| **Schema** | `src/tools/types.ts` → `DelegateToPlannerArgsSchema` |
| **Underlying implementation** | `src/planner/planner.ts` → `runPlanner({...})` |
| **Prompts** | `src/planner/prompts.ts` → `REAPER_PLANNER_SYSTEM_PROMPT`, `REAPER_REPLANNER_SYSTEM_PROMPT` (the `update_todo` mode reuses the replanner prompt) |
| **Model role** | `planner` |
| **Args** | `{ mode: "initial" \| "replan" \| "update_todo", current_step_id?: string, reason?: string }` |
| **Returns** | `{ ok, mode, plan: PlannerPlan, summary, error? }` |
| **Logged?** | Yes — `runPlanner` calls `logSubagentPrompt` with `subagent: "planner"`, `metadata: { mode, call_kind: "delegated_by_main_model" }`. |

**Modes:**

- **`mode="initial"`** — call this first, before doing any work, on any
  non-trivial task. The Planner decomposes the user's task into a typed
  plan (`plan[]`, `verification_strategy`, `done_definition`,
  `executor_guidance`). You then execute the plan step by step using the
  regular file/shell tools. Do not call this for trivial single-tool
  work.
- **`mode="replan"`** — call this when the current plan is no longer
  workable: a step is stuck, a tool keeps failing, a verification
  failed, or the task is broader than the original plan covered. Pass
  failures / new context in `reason`. The Planner returns a revised
  plan; the runtime merges successfully-completed steps so you do not
  redo work.
- **`mode="update_todo"`** — call this when only the current step's
  todo needs updating (e.g. you discovered a sub-task mid-step). Keeps
  the rest of the plan stable.

**When to skip:** trivial single-tool work (one shell command, one file
read, one file write). Just do it directly.

### 4.2 `agent` (single subagent delegation)

| | |
|---|---|
| **File** | `src/tools/agent.types.ts` (schema), `src/tools/executor.ts` (dispatch), `src/adaptive/swarm/agent-tool.ts` (impl) |
| **Args** | `{ description, prompt, subagent_type?, model?, resume?, run_in_background?, timeout? }` |
| **Returns** | A formatted text block with `agent_id`, `status`, `duration_ms`, `turns`, `tool_calls`, `tokens_used`, and (on `completed`) the subagent's summary. |
| **Foreground default; background optional** | Foreground is the safe default; `run_in_background: true` only when the task can continue independently. |
| **Resume** | Pass `resume: "<agent_id>"` to continue an existing subagent with a follow-up prompt. The subagent's full context is preserved. |

The `agent` tool spawns one focused subagent with its own context
window and tool set, and returns only the summary to the parent.
Use it when you have a single, focused task that benefits from
its own context window. Do **not** use it for trivial single-tool
work or for work that depends on the parent's in-flight state —
those cases are faster done directly.

### 4.3 `agent_swarm` (parallel fan-out)

| | |
|---|---|
| **File** | `src/tools/agent-swarm.types.ts` (schema), `src/tools/executor.ts` (dispatch), `src/adaptive/swarm/agent-swarm-tool.ts` (impl) |
| **Args** | `{ description, prompt_template, items, subagent_type?, model?, timeout?, max_concurrency? }` |
| **Returns** | A single formatted `<agent_swarm_result>` block with one `<subagent item=... agent_id=... outcome=... duration_ms=... tokens=...>` child per item. |
| **Constraints** | `items.length` is `1..128` (`MAX_AGENT_SWARM_SUBAGENTS`); `prompt_template` must contain the literal `{{item}}` placeholder; `max_concurrency` defaults to 5 and is clamped to `1..32`. |
| **Failure handling** | If any item fails, the result is `partial` (or `failed` if all fail) and the envelope includes a `resume` hint telling the parent how to re-launch the failing item via the `agent` tool. |

Use `agent_swarm` when you have many independent investigations or
tasks that can run in parallel — for example, exploring N subsystems,
auditing N modules, or running N independent experiments. The template
+ items pattern keeps the prompt shape identical across items so the
runtime can substitute safely.

### 4.4 `activate_skill`

Unchanged. Activates a specialized agent skill by name. Returns the
skill's instructions wrapped in `<activated_skill>` tags.

### 4.5 `advance_step`

Control-plane signal. The current plan step is complete; advance to
the next step. Not a sub-agent.

### 4.6 What used to be here (deleted)

- **`request_patch`** — deleted. Tool failures now go to the main
  model; the main model decides whether to retry, fix, or call
  `delegate_to_planner(mode="replan")`.
- **`delegate_to_plan`** — legacy; replaced by `delegate_to_planner`.
- **`delegate_to_plan` → `SwarmOrchestrator`** — the old
  `delegate_to_plan` tool routed into a 7-role engine-orchestrated
  swarm. Both the tool and the orchestrator are gone; parallel work
  is now done by the main model calling `agent_swarm` directly.

---

## 5. How a sub-agent call gets logged (so you can inspect what they saw)

Every sub-agent call writes a `subagent_prompt` trajectory event with
`subagent`, `role`, `model`, `system_prompt` (redacted), `user_prompt`
(redacted), and `metadata`. Use `trajectory.jsonl` to inspect exactly
what each subagent saw:

```bash
# What the Planner saw on every invocation
jq -c 'select(.kind == "subagent_prompt" and .subagent == "planner")' \
  /path/to/run/trajectory.jsonl

# What every model-driven subagent saw
jq -c 'select(.kind == "subagent_prompt" and .subagent | startswith("subagent_"))' \
  /path/to/run/trajectory.jsonl
```

Secrets in prompts are redacted via the existing `redaction.ts` layer
(common API key shapes, JWTs, AWS keys, etc.). Do not paste raw
secrets into user messages.

---

## 6. Sub-agent prompt source table

| Sub-agent | System prompt | User message renderer | File |
|---|---|---|---|
| `planner` (initial) | `REAPER_PLANNER_SYSTEM_PROMPT` | `renderInitialUserMessage` | `src/planner/{prompts,planner}.ts` |
| `planner` (replan) | `REAPER_REPLANNER_SYSTEM_PROMPT` | `renderReplanUserMessage` | `src/planner/{prompts,planner}.ts` |
| `planner` (update_todo) | `REAPER_REPLANNER_SYSTEM_PROMPT` | `renderUpdateTodoUserMessage` | `src/planner/{prompts,planner}.ts` |
| `summarizer` | inline in `generateFinalSummary` | inline | `src/runtime/engine.ts` |
| `agent` / `agent_swarm` subagent | parent base + `system_prompt_addition` from the YAML type | inline (the user's `prompt` for `agent`; `prompt_template.replaceAll("{{item}}", item)` for `agent_swarm`) | `src/adaptive/swarm/{prepare,agent-tool,agent-swarm-tool}.ts` |

---

## 7. Adding a new sub-agent — checklist

### 7.1 Adding a new model-driven built-in subagent type

1. Drop a new YAML file under `src/adaptive/swarm/builtin-types/`
   with `name`, `description`, `when_to_use`, `default_model`,
   `supports_background`, `system_prompt_addition`, and either
   `allowed_tools` or `exclude_tools`.
2. (Optional) Add a unit test in
   `tests/unit/adaptive/swarm.test.ts` that registers the type and
   asserts `LaborMarket.listBuiltinTypes()` includes it.
3. Update this doc: add a row to §3.2.

### 7.2 Adding a new top-level tool-sub-agent

1. Define the args schema in `src/tools/<name>.types.ts` using zod.
2. Add an entry to `src/tools/registry.ts` with `description` and
   `argsSchema`. Add the tool name to `CORE_TOOL_NAMES` if the main
   model should always see the full schema.
3. Add the tool to the `ToolCallSchema` discriminated union in
   `src/tools/types.ts` so TypeScript accepts the new tool name in
   the executor's switch.
4. Implement the handler and add a `case "<name>":` to
   `src/tools/executor.ts`.
5. Add a unit test under `tests/unit/tools/` covering schema
   validation, dispatch, and result envelope.
6. Update this doc (add a row to §1, a section in §4, and a step in §7).

---

## 8. Quick reference: who calls who

```
User
  │
  ▼
RuntimeEngine.run()
  │
  ▼
Main model (the only loop)
  │
  ├──tool_use──▶ delegate_to_planner(mode="initial")
  │                  │
  │                  ▼
  │               Planner (runPlanner)
  │                  │
  │                  ▼
  │               PlannerPlan
  │                  │
  ◀───{plan}─────────┘
  │
  ├──tool_use──▶ agent(description, prompt, ...)   ◀── single subagent delegation
  │                  │
  │                  ▼
  │               SubagentStore.createInstance → ForegroundSubagentRunner
  │                  │
  ◀───{summary}──────┘
  │
  ├──tool_use──▶ agent_swarm(description, prompt_template, items, ...)
  │                  │
  │                  ▼
  │               SubagentBatch (bounded concurrency) ──▶ ForegroundSubagentRunner × N
  │                  │
  ◀───{<agent_swarm_result>}──┘
  │
  ├──tool_use──▶ file/shell/test tools
  ...
  │
  └──tool_use──▶ complete_task
                  (or no executable tool calls)
                            │
                            ▼
                       summarize (one model call)
                            │
                            ▼
                       Final summary
```

The main model is the only entity that decides when to delegate.
There is no engine-side swarm decision gate.
