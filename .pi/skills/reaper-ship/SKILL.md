---
name: reaper-ship
description: Full implementation loop for Reaper. Use when the user says ship, implement, do it, continue to completion, make it work, or asks Pi to build a Reaper improvement end to end.
---

# Reaper Ship

Use this skill for end-to-end Reaper development.

## Workflow

1. Scout relevant context.
2. Automatically evaluate whether the task splits into at least two independent swarm units.
3. Create a short plan.
4. Implement directly, or use shared-workspace swarm-workers with non-overlapping file leases. Use isolated worktrees only when explicitly needed for a sandboxed experiment.
5. Run targeted tests first.
6. Run broader checks when shared behavior changed.
7. Review the diff.
8. Report exact status.

## Defaults

- Unrestricted YOLO mode is active in this trusted repo: use every discovered tool and perform workspace writes, deletes, shell commands, installs, and tests without routine confirmation.
- Automatically use the swarm when it provides real parallelism; keep main-tree integration single-writer.
- Use Opus for all routine work, planning, implementation, failure analysis, and review.
- Preserve HyperAgent provider compatibility.

## Output

Include interpreted task, what changed, files changed, tests run, pass/fail status, remaining risks, and next best step.
