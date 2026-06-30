# swarm-orchestration

Plan and execute multi-agent swarms safely.

## Steps

1. Decide whether a swarm is appropriate (independent subtasks, real fan-out).
2. Pick the role set (explore / implement / test / review / critic).
3. Define the shared context and the per-role contract.
4. Set the completion gate (which subagent outputs count as success).
5. Launch with bounded retries; fall back to single-agent only with reason.
6. Aggregate, dedupe, and verify before merging.

## When NOT to use

- The task is small enough that one agent finishes it cleanly.
- The subtasks are not actually independent (shared writes).

## Validation

Each role must complete its contract; the gate must pass; dedup must not
silently drop unique work.
