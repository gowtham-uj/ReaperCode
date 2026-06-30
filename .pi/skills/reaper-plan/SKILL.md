---
name: reaper-plan
description: Planning and architecture workflow for Reaper. Use when the user asks for a plan, design, architecture, roadmap, refactor strategy, or how to implement a Reaper feature safely.
---

# Reaper Plan

Use this skill to turn unclear or complex Reaper work into a concrete plan.

## Workflow

1. Scout enough context to avoid guessing.
2. Define the objective, non-goals, affected modules, state/schema changes, and tool/provider implications.
3. Keep implementation single-threaded.
4. Prefer small, reviewable steps.
5. Include tests and rollback strategy.
6. Do not edit files unless the user explicitly asks to implement.

## Output

Return:

- interpreted objective
- relevant files
- proposed design
- implementation steps
- tests to run
- risks and rollback
- confidence
