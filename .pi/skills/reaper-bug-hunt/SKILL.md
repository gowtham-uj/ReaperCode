---
name: reaper-bug-hunt
description: Reproduce, diagnose, and fix Reaper bugs or failed runs. Use for prompts mentioning failures, logs, stuck loops, failing tests, regressions, "why failed", "fix bug", or unresolved benchmark tasks.
---

# Reaper Bug Hunt

Use this skill for evidence-first debugging.

## Workflow

1. Collect the newest relevant error, log, test, or run artifact.
2. Reproduce or trace the failure when practical.
3. Identify the root cause from evidence.
4. Patch the smallest general Reaper surface that addresses the pattern.
5. Add or run a focused regression check.
6. Review the diff before finalizing.

## Rules

- Do not make task-specific benchmark hacks.
- Do not fabricate test results.
- If the failure is infrastructure, classify it honestly.
- Prefer generic improvements to agent loop, provider handling, tool feedback, verification, or recovery.

## Output

Include root cause, changed files, tests run, pass/fail status, remaining risks, and next best step.
