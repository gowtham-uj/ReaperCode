---
name: swarm
description: Orchestrate a controllable swarm of parallel agents in Pi to finish a task faster. Use when work splits into independent units that can run concurrently - multi-file refactors, fan-out research, parallel implementation in the shared workspace. Covers decomposition, file leases, background fan-out, mid-run steering, review gating, and single-writer integration.
---

# Swarm

Use Pi as an orchestrator that controls a swarm of subagents running in parallel. Pi already provides the engine; this skill is the discipline that makes parallel agents fast AND safe.

## Automatic routing

The Reaper cockpit automatically selects this skill for explicit swarm/parallel-agent requests and for non-trivial tasks likely to split into independent units. Do not wait for the user to ask again.

- Always inspect `git status --short` before parallel writes. Shared-workspace workers can see the live checkout, so lease discipline must account for uncommitted main-tree changes.
- If the task has at least two independent non-overlapping units, fan out.
- If it does not, continue directly instead of spending time on artificial parallelism.
- Even when parallel writes are unsafe, use parallel read-only scouts, failure analyzers, or test investigators when useful.

## Primitives (already in Pi)

- Agent with run_in_background set to true: launch a worker that runs concurrently. Swarm scouts, workers, and reviewers default to background execution in this repository.
- Multiple Agent calls in ONE message: true parallel fan-out.
- Workers run in the same checkout by default. File leases and single-writer integration prevent clobbering.
- get_subagent_result: collect or poll a worker (pass wait true to block until done).
- steer_subagent: redirect a running worker mid-flight, so you stay in control.

## Roles (subagent_type)

- swarm-scout: read-only background scout; maps the task into conflict-free units with a bounded turn budget.
- swarm-worker: background implementer; owns one file lease and runs in the shared checkout.
- swarm-reviewer: background independent gate; verifies a worker diff before integration with a bounded turn budget.

## The invariant

Lease discipline plus single-writer integration equals safe parallelism in the shared checkout.
No two concurrent workers may touch the same file. Only the orchestrator writes to the main tree.

## Loop

1. Preflight. Inspect git status and identify relevant uncommitted changes that workers will see in the shared checkout.
2. Decompose. Fan out background swarm-scouts when useful. Continue useful parent-side preflight while they run, then collect results. Split the task into units, each with a goal, a verify command, and a file lease that does NOT overlap any other concurrent unit. Serialize anything that touches shared or hot files.
3. Fan out. In a SINGLE message, launch one swarm-worker per unit with run_in_background true. Give each a self-contained prompt: its goal, its exact file lease, its verify command, and the output fields to return.
4. Monitor and steer. Poll with get_subagent_result. If a worker drifts or exceeds its lease, use steer_subagent to correct it; if it is unrecoverable, let it finish and discard the branch.
5. Gate. For each finished worker, launch swarm-reviewer on its diff. Only branches with verdict pass proceed.
6. Integrate single-writer. The orchestrator merges passing edits into the main tree one at a time, resolving any conflicts itself. Workers never merge.
7. Verify once. Run the full suite on the integrated tree. Report per-unit pass/fail, the integration result, and remaining risks.

## When NOT to swarm

- Units share files that cannot be cleanly leased: run serial.
- Task is small (one or two files): the orchestrator does it directly.
- Tight sequential dependency chain: there is no parallelism to exploit.

## Example

Ask: use the swarm skill to split this refactor across src/a.ts, src/b.ts, and src/c.ts into 3 swarm-workers in the shared workspace, review each, then integrate.

Orchestrator: decompose, launch 3 background workers (one lease each), poll and steer, review each diff, merge passing edits single-writer, run the suite once, then report.
