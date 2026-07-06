# Pre-A/B Pre-Strict-Config Snapshot

**Date:** 2026-07-06 05:21:23 UTC
**Branch:** main
**HEAD commit:** d3ebcb9 (workspace-level Reaper config + normalized envelope pruning)
**Stash name:** `pre-strict-config-pre-ab-test-snapshot`

## Why this snapshot exists

Just before launching a stress A/B test that exercises the new strict-config
machinery. The changes on disk are uncommitted and risky — if the A/B run
messes up the source tree, we want to be able to roll back to exactly this
state.

## What's in it

- 85 changed/new files (49KB diff, 1086 lines)
- All new modules (session-journal, persistent-summary, full-summary, etc.)
- All new tests (138/138 passing)
- Strict-config schema additions (`ContextManagementConfigSchema`,
  `RuntimeTunablesConfigSchema`)
- Engine wires `applyConfigToTunables(config)` at boot
- 62 env-var reads replaced with `getXxxTunables().field` cache calls
- starter-config writes complete config (no secrets — API keys stay in env)

## How to restore this snapshot

If something gets messed up later:

```bash
# 1. Verify the stash still exists
git stash list

# 2. Apply on top of HEAD
git stash apply stash@{0}

# 3. If conflicts, drop the working tree first
git checkout -- .
git clean -fd
git stash pop

# 4. Verify
npx tsc --noEmit -p tsconfig.json
# should report tsc=0
```

## Files (full list)

See `file-list.txt`.

## Status at snapshot time

- typecheck: 0
- build: 0
- focused tests: 138/138 pass
- env reads remaining: 5 (all internal control flags — REAPER_DEV,
  REAPER_SHAKE_CONTEXT_WINDOW_TOKENS, REAPER_TUI_THEME, REAPER_RESUME_RUN_ID
  ×2)