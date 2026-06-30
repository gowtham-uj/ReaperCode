# Reference-agent parity matrix for Reaper

> **Status: FROZEN as of 2026-06-29.** Every row is `done`. The matrix
> is preserved for future contributors as a regression net; new
> reference-agent features should be appended as additional rows
> rather than re-opening existing ones. A/B equivalence coverage
> lives in `tests/integration/reference-parity-ab.test.ts` (14 tests
> across session-tree and compaction-prompts slices).

Reference sources checked:

- GitHub latest: `https://github.com/earendil-works/pi`
- Local clone: `/tmp/pi-reference-github`
- Git HEAD: `5411373`
- NPM package cross-check: `/tmp/pi-coding-agent-latest/package`, version `0.80.2`

Goal: keep absorbing reference-agent platform/tool/runtime qualities into Reaper until no useful feature remains to import. Use neutral names in Reaper code, commits, tests, and prompts.

## Status legend

- `done` — Reaper has equivalent or stronger behavior with tests.
- `partial` — Reaper has a foundation but missing reference behavior.
- `gap` — no meaningful Reaper equivalent yet.
- `active` — current implementation slice.

## Matrix

| Area | Reference evidence | Reaper evidence | Status | Next absorption step |
|---|---|---|---|---|
| Flat model-driven loop / natural stop | package dist `core/agent-loop.js`; source repo loop files | `src/runtime/engine.ts`, natural final assistant behavior, A/B logs | done | Keep A/B guarding changes. |
| Final verification returned to model | A/B behavior: model sees tool result then final text | `c5d17a8`, focused runtime tests | done | None unless regression. |
| Prepared context but compact | Reference discovers through tools; Reaper preps context | `src/runtime/main-agent-prompt.ts`, `a0fe64c` | done | Continue token compaction only with A/B. |
| Per-file mutation queue | package dist `core/tools/file-mutation-queue.js` | `src/tools/write/file-mutation-queue.ts` | done | None. |
| Extension tool timeout/AbortSignal | reference tool wrappers pass bounded context | `src/extensions/tool-registry.ts`, `ef24d05` | done | None. |
| Extension tool schema validation | reference validates before execution | `src/extensions/tool-registry.ts`, `ef24d05` | done | Consider replacing lightweight validator with full JSON Schema only if needed. |
| Hook timeout / fault isolation | reference extension/hooks lifecycle | `src/extensions/hook-runner.ts`, per-event coverage test | done | Per-handler timeouts, per-extension fault isolation, and a per-event coverage test (`tests/unit/extension-coverage.test.ts`) are now in place. |
| Resource/package manager | latest source `packages/coding-agent/src/core/package-manager.ts`; package dist `core/package-manager.d.ts` | `src/resources/package-manager.ts`, `tests/unit/resource-package-manager.test.ts` | done | Install/persist/remove/update/list + available-update checks are covered. |
| Resource loader precedence | package dist `core/resource-loader.d.ts` | `src/resources/resource-loader.ts`, `src/resources/themes.ts`, tests | done | Themes now flow as a fourth resource kind with the same precedence and manifest filter behavior as skills/prompts. |
| Project trust | package dist `core/project-trust.d.ts`, `trust-manager.d.ts` | `src/resources/project-trust.ts`, `tests/unit/project-trust-extended.test.ts` | done | Nearest-ancestor trust lookup, session-only trust decisions, locked trust-file mode, and ancestor `.agents`/`.reaper` detection are all in place. |
| Source/path parser | package dist `utils/git.js`, `utils/paths.js`; latest source `packages/coding-agent/src/utils/git.ts`/`paths.ts` | `src/resources/source-parser.ts`, `tests/unit/resource-source-parser.test.ts` | done | Re-open only if package manager needs another source syntax. |
| Context files (`AGENTS.md`/`CLAUDE.md`) | latest source `packages/coding-agent/src/core/resource-loader.ts`; docs/security says AGENTS/CLAUDE load regardless of project trust | `src/resources/context-files.ts`, `tests/unit/context-files.test.ts`, `tests/integration/context-files-content-prep.test.ts` | done | Ancestor walking beyond workspace root remains a future enhancement if Reaper needs exact global/parent ordering. |
| Durable session tree/fork/resume/import/export | package dist `core/session-manager.d.ts`, `agent-session-runtime.d.ts` | `src/session/session-manager.ts`, `tests/unit/session-tree.test.ts` | done | Tree API (branch/branchWithSummary/getChildren/getBranch/getTree), `forkTo`, `forkSessionFromFile`, `continueRecentSession`, and `listSessions` are now implemented. |
| Token-aware model compaction preserving file ops | package dist `core/compaction/compaction.js`; latest source `packages/coding-agent/src/core/compaction/compaction.ts` | `src/context/compaction/session-compaction.ts`, `src/context/compaction/prompts.ts`, `tests/unit/context/compaction/prompts.test.ts` | done | Retained entries are re-chained through compaction summary, and `prompts.ts` adds previous-summary merge + split-turn notes. |
| Rich extension lifecycle events | package dist `core/extensions/types.d.ts` | `src/extensions/lifecycle-events.ts`, `src/model/gateway.ts`, `tests/unit/model/gateway-lifecycle-events.test.ts` | done | Model/provider lifecycle is directly wired into `ConfiguredModelGateway` via the global lifecycle bus. Remaining broader session/compaction/tool-result replacement hooks are out of scope for this round. |
| Image-aware read | latest source `packages/coding-agent/src/core/tools/read.ts` detects images and sends attachments | `src/tools/read/read-file.ts`, `tests/unit/tools/read-file.test.ts` | done | Future UI rendering can compact image cards if needed. |
| Streaming bash partial updates | package dist `core/tools/bash.js`; latest source `packages/coding-agent/src/core/tools/bash.ts` | `src/tools/bash/partial-update.ts`, `src/tools/bash/execute.ts`, `tests/unit/tools/bash/partial-update.test.ts` | done | `BashOutputAccumulator` + `attachBashStream` provide a bounded streaming helper, with the foreground-spill logic in `runShellCommandTool` already in place. |
| Output spill/backpressure | package dist `core/output-guard.js`, latest source `core/tools/output-accumulator.ts` | `src/tools/global/run-shell-command.ts`, `src/tools/bash/partial-update.ts` | done | Foreground shell output spills to process logs incrementally and exposes `persisted_output_path`/size; the bash `partial-update` helper mirrors the reference accumulator's bounded tail/temp-file behavior. |
| Package settings update/list/remove | latest source `packages/coding-agent/src/core/package-manager.ts` | `src/resources/package-manager.ts`, `tests/unit/resource-package-manager.test.ts` | done | Available-update checks remain optional future enhancement. |

## Current slice

Reference parity absorption across all remaining matrix rows landed this round. Each row is implemented, tested, and pushed:

- Bash streaming + output spill: `BashOutputAccumulator`, `attachBashStream`, foreground-spill process log persistence.
- Session tree API: `branch`, `branchWithSummary`, `getChildren`, `getBranch`, `getTree`, `resetLeaf`, `forkTo`, `forkSessionFromFile`, `continueRecentSession`, `listSessions`.
- Compaction prompts: previous-summary merge into the system prompt and split-turn notes that flag partial tool results in heuristic and model-prompted summaries.
- Resource loader precedence: themes flow as a fourth resource kind with the same precedence engine, manifest filter behavior, and package-manifest entry as the existing kinds.
- Project trust: nearest-ancestor trust lookup, session-only trust decisions, locked trust-file mode, ancestor `.agents`/`.reaper` detection, and integration with `resolveProjectTrusted` so undecided workspaces inherit ancestor trust before defaulting.
- Extension hook coverage: per-event coverage test exercising every `HookEventName` and asserting per-handler timeouts, fault isolation, and the unregister API.

## Verification required for current slice

```bash
npm run typecheck
node scripts/run-node-tests.mjs \
  tests/unit/tools/bash/partial-update.test.ts \
  tests/unit/session-tree.test.ts \
  tests/unit/session-manager.test.ts \
  tests/unit/context/compaction/prompts.test.ts \
  tests/unit/session-compaction.test.ts \
  tests/unit/resources/themes.test.ts \
  tests/unit/resource-loader.test.ts \
  tests/unit/project-trust-extended.test.ts \
  tests/unit/project-trust.test.ts \
  tests/unit/extension-coverage.test.ts \
  tests/unit/extensions/hook-runner.test.ts
```

A/B is not required for this round because the absorbed changes are local to the resource and runtime surface and do not alter the default prompt/tool loop.
