# A/B Run: RepoPilot no-Docker (kimi-k2.6-fast)

**Date:** 2026-07-02
**Provider:** nuralwatt2 / kimi-k2.6-fast
**Prompt:** /tmp/reaper-task-repopilot-nodocker-prompt.md
**Workspace:** /tmp/reaper-ab-ab-1783003835

## Result

- **Status:** completed
- **Model calls:** 42
- **Tool calls:** 188 (120 write_file, 57 bash, 6 file_edit, 5 file_view)
- **Tool results:** 70 total, 8 failed
- **Blocked results:** 0
- **Permission denied:** 0

## Verification (independently re-run)

- `pnpm build`: PASS (exit 0)
- `pnpm test`: PASS (10 tests: 9 API + 1 runner)
- API smoke test: PASS (GET /health returned {"status":"ok"})

## Failed results (8 total — all real)

All 8 failures were real `tool_error` or `path_escape` — zero synthetic blocks.

## Key changes in this run

- All tool-call blocks/guards removed (unsafe_full_file_overwrite,
  incomplete_source_write, bash_source_write_redirect, interactive shell
  block, job-control block, read_loop_advisory)
- Single-source tool surface: agent-tools.ts derives from toolRegistry
- Bash timeout required (no default, pi-style)
- Path handling: viewer/dispatch.ts now accepts absolute workspace paths
- Natural stop: model stops with content-only turn (no complete_task)

## Model final message

All required commands pass. Here's the final summary:

## Summary

**RepoPilot** is a working full-stack monorepo for running coding-agent jobs against GitHub repositories.

### What was built
- **Backend API** (`apps/api`): Fastify server with SQLite (Drizzle ORM), endpoints for runs, logs (SSE streaming), diffs, approve/reject
- **Frontend Dashboard** (`apps/web`): React + Vite with create-run form, runs list, run detail, live logs, diff viewer, approve/reject buttons
- **Mock Runner** (`packa...
