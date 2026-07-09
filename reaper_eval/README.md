# Reaper unified eval harness

## What this is

A single eval entrypoint that:

1. Stages a real workspace from a task JSON (or fixture copy)
2. Runs the full `RuntimeEngine` agent loop
3. Scores **explicit success gates** (tests, file contents, scratchpad, trajectory events)
4. Packages **everything the model saw and said** as readable text under an output dir

## Quick start (MiniMax-M2.7)

```bash
export MINIMAX_API_KEY='…'

# Implementation suite (real fix/refactor/debug/implement tasks)
npx tsx scripts/run-unified-eval.ts --suite implementation --provider minimax --model MiniMax-M2.7

# Days-long context-engineering suite (softCap pressure + user-note survival)
npx tsx scripts/run-unified-eval.ts --suite context-days --provider minimax --model MiniMax-M2.7

# One task
npx tsx scripts/run-unified-eval.ts --task reaper_eval/suites/implementation/ca-fix-failing-tests.json
```

Artifacts default to `/tmp/reaper-eval-out/<taskId>-<timestamp>/`.

## Output layout (per run)

| File | Purpose |
|---|---|
| `MODEL_IO.md` | Chronological transcript of **every** model call: system + messages + tools + model output |
| `model-calls/NNNN-generate.txt` | Same content, one file per call (exactly the context window view) |
| `model-calls/NNNN-generate.json` | Structured JSON of the same call |
| `trajectory.jsonl` | Tool calls, shake, token_budget, session events |
| `verification.log` | Post-run gate command stdout/stderr |
| `scratchpad.md` | Durable working notes (if used) |
| `summaries/` | Full-summary artifacts (if compaction fired) |
| `result.json` | Pass/fail + gate details |
| `PROMPT.md` | The task prompt |
| `README.md` | How to read the artifacts |

## Task schema (v1)

See `reaper_eval/runtime/task-schema.ts`. Important fields:

- `prompt` — user request
- `projectFiles` — embedded workspace files
- `softCap` — optional context soft cap (context-days uses ~30k to force shake)
- `verification.command` — shell check
- `gates` — ALL must pass (`verification_exit_0`, `file_contains`, `scratchpad_contains`, `trajectory_kind`, …)

## Suites

### `implementation`

Real coding loops (not toy string replaces only):

- `ca-fix-failing-tests` — diagnose failing TS tests, fix, scratchpad note
- `ca-multi-file-refactor` — extract shared util across files
- `ca-debug-from-logs` — root-cause from integration log
- `ca-implement-from-spec` — implement from SPEC.md

### `context-days`

Long-running continuity under compaction pressure:

- `cd-plan-edit-remember` — 20 edits + preserve user codename across shake
- `cd-reread-after-shake` — read keys, create noise, recall after pressure
- `cd-resume-continuity` — mid-session resume with user preference journaling

## Model I/O logging (engine)

Every `generate`/`stream` now writes:

- `.reaper/runs/<runId>/model-calls/<id>.json`
- `.reaper/runs/<runId>/model-calls/<id>.txt`
- `.reaper/runs/<runId>/model-calls/TRANSCRIPT.md`

Wired via `setModelCallLogContext` in `RuntimeEngine.run()`.

## Legacy

Old `reaper_eval/tasks/*.json` still load via `loadEvalTaskFile` (maps `description` → `prompt` and default `verification_exit_0` gate). Prefer the new suites.
