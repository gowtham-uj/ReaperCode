# Reaper

A model-agnostic TypeScript harness for long-horizon coding agents. Reaper is the testing ground where I throw every harness-engineering idea at the wall to see what actually survives a real session — context compression, provider routing, structured recovery, progressive tool disclosure. It's dogfooded daily, and most of what gets built here ends up ripped out again in the name of simplicity.

## What it actually does

Reaper runs an autonomous coding loop that survives very long tasks without losing its mind:

- **Context engineering with a 270K token hard cap.** A layered pipeline of `token-budget` → `shake` (cheap safe-to-prune scrubbing) → `microcompact` → `reactive-compact` → `compaction-checkpoint` → `full-summary` → `persistent-summary` decides when and how to age out old turns. A single `should-compact` gate fires off OMP's `softCap − 16K reserve` heuristic. The system prompt is **never** replaced — only the surrounding history is compressed and rehydrated on the next call.
- **Cockpit with prompt-cache-friendly tiers.** `buildMainAgentCockpit` lays out system / stable / volatile sections in prefix-stable order so the provider's prompt cache stays warm across turns.
- **Proactive repo context.** `indexer` + `graph` + Aider-style PageRank ranking + SWE-pruner produce a budgeted repo map under a token ceiling, so the agent starts the turn knowing which files matter.
- **ACI file tools and progressive tool disclosure.** `file_view` / `file_scroll` / `file_find` / `file_edit` give viewport-style reads. A core tool set (~12 names) ships by default; deeper tools surface via `search_tools` + BM25 descriptors.
- **Parallel tool islands.** `execution/scheduler.ts` + `resource-keys.ts` let safe reads and shells run concurrently without colliding on shared resources.
- **Provider-agnostic model routing.** Anthropic, OpenAI, LiteLLM-gateway, and MiniMax / HyperAgent providers share one `model/gateway.ts` with stream normalization, structured tool-call events, and a `node-watcher` that kills stuck model streams.
- **Unified tool dispatch.** One `executor` + `registry` pair (`src/tools/`) wraps bash, file read / write / edit / delete, ast-grep, web search / fetch, browser, computer-use, MCP, memory search, and 16+ built-in skills behind a single allowlist-gated, permission-checked, shell-risk-classified surface.
- **WAL / shadow checkpoints.** `recovery/` flushes writes through a write-ahead-log shell before mutating commands touch real state.
- **Verified recovery.** `recovery/verified-memory.ts` and `verify/` (judge, runner, contract-coverage, semantic-failure) catch hallucinations and force the agent to re-derive claims from real artifacts.
- **Hooks, skills, extensions.** First-class `hooks/`, `skills/`, and `extensions/` subsystems for runtime customization without forking the runtime.
- **Internal task tracking.** `task.ts` exposes a TodoWrite-style `createTask` / `updateTask` / `listTasks` API scoped per run, so the agent can manage its own in-progress work without polluting global state.

## Architecture in one breath

`runtime/engine.ts` owns the loop. Each turn:

1. Build the request — **system prompt** (`runtime/system-prompt.ts`) + budgeted context (repo map + skills + AGENTS.md + microcompacted history) via `buildMainAgentCockpit`.
2. Route it through the model gateway to a provider.
3. Stream structured tool-call events back through the dispatcher.
4. Run each tool through policy (`policy/sandbox.ts`, `governance/shell-risk.ts`), the allowlist, the result normalizer, and the parallel scheduler (safe reads / shells in parallel islands).
5. Apply `shake` + `ctxHooks` to the result.
6. Return the tool result to the model.
7. On overflow, fire the compaction pipeline. On hard cap (270K), trigger a full session summary and rehydrate cleanly on the next turn — without ever touching the system prompt.

## Sub-agent delegation (in-progress)

A delegation substrate exists at `orchestration/sub-agents.ts` (`runDelegatedPlan`) with depth limits, plan-cycle detection, sandbox workspaces, and file leases. A `DelegateSubTaskSchema` is declared. The `subagent` skill-usage mode, `subagent_prompt` log kind, and `subagent_result` tool-validation path are wired. A user-facing swarm tool is **planned but not shipped** — the audit explicitly defers swarm reintroduction until the context layer is fully wired, because parallel agents amplify context bugs.

## State of the project

- **Context engineering**: 270K-cap stress runs green, 14/14 gates passing per the latest eval.
- **Sub-agent architecture**: delegation substrate + hooks + logging in place; user-facing tool surface still pending.
- **Web UI**: planned, single-page cockpit similar to OpenHands' agent canvas.
- **Offensive-security fork**: a red-team operator agent is being spun off this runtime in a separate repo.

## Lessons baked in

I learned how *not* to build a coding agent in 100 different ways. Most of what you see in `src/` is what survived that winnowing. The boring parts are boring on purpose.

## Running it

```bash
git clone https://github.com/gowtham-uj/ReaperCode.git
cd ReaperCode
npm install
npm run build

echo "MINIMAX_API_KEY=your_key_here" > .env

# One-shot exec
npm run reaper:exec -- "Analyze src/ and summarize the context-engineering layer" --provider minimax --model MiniMax-M3

# Interactive TUI
npm run reaper:dev
```

## Disclaimer

I maintain Reaper for as long as I personally use it. No guarantees. You're welcome to take the code and run.