---
name: reaper-dev-loop
description: Turn short Reaper development prompts into a scout, plan, implement, test, review, and security-review workflow.
---

# Reaper Development Loop

Use this skill when the user asks to improve, fix, review, speed up, clean up, or ship work in the Reaper implementation harness.

## Workflow

Unrestricted YOLO mode is active for the trusted `/workspace` repository. Use available tools directly for workspace reads, writes, edits, deletes, shell commands, installs, and tests without asking for routine confirmation.

1. Interpret the user's short prompt into a precise Reaper objective.
2. For non-trivial tasks, automatically evaluate the swarm route. Use parallel read-only scouts, and use shared-workspace workers when at least two independent non-overlapping implementation units exist.
3. Aggregate findings into relevant files, symbols, patterns, risks, and next step.
4. Ask an architect/planner for a concrete plan before editing.
5. Implement only after the plan is clear.
6. Use the shared workspace for parallel implementation by default; prefer isolated git worktrees only when explicitly needed for a risky experiment.
7. Run targeted tests first; use `npm test` and `npm run typecheck` for broader validation when warranted.
8. Review the diff before finalizing.
9. Run security review for changes involving tool execution, sandboxing, secrets, subagents, packages, external processes, network access, persistent memory, provider routing, or benchmark infrastructure.
10. Do not fabricate results. If validation cannot run, say so.

## Short Prompt Expansion

- "fix session bug" means inspect session/persistence, reproduce or trace the failure, patch only related files, run targeted tests, and report risk.
- "add subagents" means inspect the agent loop/state graph, design roles and schemas, implement the smallest useful orchestration surface, add tests, and review reliability/security.
- "make it faster" means inspect model calls, tools, context handling, file search, memory, and tests; implement only safe high-impact optimizations.
- "clean this up" means inspect first, propose a behavior-preserving refactor, make minimal changes, test, and review.
- "ship this" means run scout, plan, implement, test, review, security review when needed, and summarize remaining risks.

## HyperAgent Provider Notes

This repo includes a project Pi extension at `.pi/extensions/hyperagent-provider.ts` that registers:

- provider: `hyperagent`
- model: `claude-opus-4-8`

Opus is the sole HyperAgent Pi model. Authentication is browser-profile managed; do not export raw cookies or tokens.

## Pi Tool And Extension Work

When the user asks Pi to create, change, or test Pi's own tools, extensions, providers, or cockpit workflow, preserve the HyperAgent tool bridge and test it directly.

- Keep `claude-opus-4-8` working with every discovered Pi tool.
- Opus uses the schema-driven `PI_CALL` protocol, converted by the provider into structured Pi tool calls.
- Do not add tools that bypass the shared schema-driven tool path.
- Use unique marker files for live tool tests.
- Prefer `pi --mode json` so the report can verify `toolcall_start`, `tool_execution_start`, and `tool_execution_end`.
- A final report must include Opus structured tool-event evidence and continuation behavior after results.

## Final Response Shape

Every implementation or ship response must include:

- interpreted task
- what changed
- files changed
- tests run
- pass/fail status
- remaining risks
- next best step
