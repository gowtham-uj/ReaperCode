---
name: reaper-bench
description: Benchmark and eval workflow for Reaper. Use for Terminal-Bench, phase runs, pass counts, failed task sets, eval logs, results.json, reaper-audit.jsonl, langfuse-events.jsonl, or before/after benchmark comparisons.
---

# Reaper Bench

Use this skill for Reaper benchmark and eval operations.

## Workflow

1. Identify the requested run set, task set, or phase.
2. Inspect `results.json`, recent logs, audit JSONL, and eval summaries before rerunning.
3. Report unique passed tasks, unresolved failed tasks, infra failures, and timeouts separately.
4. When rerunning, run only the requested or unresolved subset unless told otherwise.
5. Preserve logs needed for analysis.

## Output

Include:

- run set inspected
- pass/fail/infra/timeout counts
- unresolved task IDs
- important log paths
- command run, if any
- next action
