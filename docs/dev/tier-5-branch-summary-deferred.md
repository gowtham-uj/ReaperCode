# T5: Branch Summarization — Deferred

## What this layer would do

Reaper's `compaction/branch-summarization.ts` implements a multi-branch conversation model:

```
                    ┌─── branch A (task A1) ───┐
master branch ──────┼                          ├── merged conversation
                    └─── branch B (task B2) ───┘
```

When the agent forks to work on a sub-task in parallel, the branch-summarization layer independently summarizes each branch. On `merge`, the summaries are concatenated into the master branch, preserving the work done in parallel.

## Why Reaper doesn't port this (yet)

Reaper's runtime is currently **single-branch**:

1. **No fork/merge primitives.** The `liveConversation` is a single `Array<GenerateRequest["messages"]>`. There's no `BranchSession` class, no `fork()` / `merge()` operations, no branch-tree data structure.

2. **No session-manager abstraction.** A session-manager with `appendMessage`, `getBranch`, `setBranch` would be needed to support multi-branch trees. Reaper's `runtime-state.ts` has `liveConversation` directly without the indirection.

3. **Schema impact.** Branch-summarization requires a new `branch_entry` trajectory event kind and changes to the persistence layer (`session-store.ts` currently writes a linear stream).

4. **Use case unclear.** The Reaper use case (long-running long-running Reaper run) doesn't typically need parallel branches. The agent's natural mode is sequential tool calls.

## What porting this would require

| Step | Effort | Notes |
|---|---|---|
| Add `BranchSession` data structure in `src/session/` | Medium | Track parent/child relationships |
| Add `fork()` / `merge()` operations on `liveConversation` | Medium | Atomic swap with merge-message injection |
| Add `branch_entry` and `branch_summary` Zod schemas | Small | |
| Wire `onBranchFork` / `onBranchMerge` hooks | Medium | Plumb through `ContextEngineeringHooks` |
| Update `session-store.ts` to write branch-tree, not linear stream | Medium | New `.reaper/branches/<id>/log.jsonl` |
| Tests for fork/merge | Small | Unit-testable, no fixture changes needed |

Estimated: **2-3 hours of focused work**, plus schema discipline + tests.

## When to port

Trigger: when Reaper's runtime starts supporting **parallel sub-agent workers** (e.g. one worker per repo directory). At that point, branch-summarization becomes necessary to keep the per-worker context compact.

Until then, this layer is intentionally NOT IMPLEMENTED. The schema includes space for `branch_summary` events but no wiring invokes them.