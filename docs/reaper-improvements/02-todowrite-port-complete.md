# TodoWrite Port — ✅ Complete

Ported cc-haha's TodoWriteTool into Reaper as `task_create` / `task_update` / `task_list`
control-plane tools backed by a per-run task store. Typecheck passes; smoke test confirms
per-run isolation.

## Why per-run

`AdaptiveEvalScheduler` runs multiple eval tasks concurrently in the same Node process. A
module-level singleton would leak task state across runs. We key by `runId` (mirrors the pattern
in `src/runtime/engine.ts`'s run context).

## Files touched

### `src/tools/write/task.ts` (rewritten)

Per-run store replacing the previous single global Map.

```ts
const DEFAULT_RUN = "__default__";
const stores = new Map<string, RunTaskState>();

export function createTask(args, runId = DEFAULT_RUN): TaskEntry { ... }
export function updateTask(args, runId = DEFAULT_RUN): TaskEntry | null { ... }
export function listTasks(status?: TaskStatus, runId = DEFAULT_RUN): TaskEntry[] { ... }
export function clearTasks(runId: string): void { stores.delete(runId); }
```

Each `RunTaskState` holds `{ tasks: Map<id, TaskEntry>; nextId: number }`.

### `src/tools/registry.ts`

Strengthened the descriptions for `task_create`, `task_update`, `task_list` in cc-haha style —
they now tell the model exactly when to call them (3+ steps, multi-file, etc.) and require
exactly one `in_progress` task at a time.

### `src/tools/executor.ts`

`case "task_create" / "task_update" / "task_list"` all pass `this.options.runId` into the
task-store functions.

### `src/runtime/engine.ts`

- Imports `listSessionTasks`, `clearSessionTasks` from `../tools/write/task.js`.
- At run init (after creating `runContext`, ~line 265): `clearSessionTasks(runContext.runId)`.
- New helper `renderSessionTasksForPrompt(runId)` injects a compact `<tasks>` block into the
  step-execution prompt so the model always sees current state.
- `getCompletionBlocker(results, runId)` now refuses `complete_task` when open tasks exist with
  an explicit message ("X tasks still pending — finish or delete them first").

## Smoke test

Confirmed isolation between two `runId`s: creating tasks under `run-A` does not appear in
`listTasks(..., "run-B")`, and `clearTasks("run-A")` does not affect `run-B`.

## What this does NOT do

- Does not auto-decompose; the model must call `task_create` itself. The strengthened
  description + the visible `<tasks>` block in every prompt is what drives the behavior.
- Does not persist tasks to disk. Tasks live for one run only.
