# Reaper v0.1.4 Implementation Roadmap — internal-harness Tool Architecture Port

**Source research:** `Reaper Tool Port Research.md`
**Target release:** v0.1.4
**Baseline:** v0.1.3 (subagents/MCP/guards removed; single-source tool surface)

## Goal

Port Reaper core tool-system capabilities into Reaper to improve efficiency, discoverability, reliability, and context control — without reintroducing blocking, forcing, or guard behavior. Each phase is validated by a small A/B smoke test that exercises the new behavior, then a final full A/B test against the no-Docker RepoReaperlot prompt.

## Hard rules

- No tool-call blocks, no forced tool choice, no approval gates.
- All diagnostics and warnings are advisory and returned inside tool results.
- Keep Reaper's existing strong tools as the primary path (`file_view`, `file_edit`, `write_file`, `bash`, background processes).
- Remove/keep-removed: subagent system and MCP system are gone until redesigned.

---

## Phase 0: Foundation sweep

**What**
- Audit remaining dead code from v0.1.3 cleanup (any leftover references to removed block codes).
- Stabilize types between `ToolType`, registry, schema, and executor.
- Add a `tools/descriptor.ts` module for the new metadata layer skeleton.
- Add a `toolResult.ts` module for the normalized result envelope skeleton.
- No behavior changes; purely additive scaffolding.

**Small A/B smoke test**
```text
Create a file named hello.txt with "hello" in the workspace root, then read it back.
```

**Pass criteria**
- `write_file` + `file_view` complete successfully.
- No regressed tool failures vs v0.1.3 baseline.
- Typecheck and focused tests pass.

---

## Phase 1: Tool descriptor layer + normalized result envelope

**What**
1. Introduce `ToolDescriptor` type around each registered tool:
   - `name`, `label`, `summary`, `description`, `argsSchema`
   - `loadMode`: `core` | `discoverable`
   - `family`: `file`, `search`, `edit`, `shell`, `job`, `diagnostic`, `web`, `memory`
   - `capabilityTier`: `read` | `write` | `exec`
   - `concurrency`: `shared` | `exclusive` | argument-derived
   - `contextCost`: `low` | `medium` | `high`
   - `aliases`, `examples`, `source`
2. Generate descriptors from existing registry schemas without touching tool bodies.
3. Introduce `NormalizedToolResult` envelope:
   - `ok`, `toolCallId`, `name`, `args`, `durationMs`, `content`, `details`, `meta`, `diagnostics`, `artifacts`, `isError`, `useless`, `advisories`
4. Add adapters that wrap current tool results into the envelope while preserving existing visible output.

**Small A/B smoke test**
```text
Create three files a.txt, b.txt, c.txt, then run a shell command to list them and verify the output contains all three names.
```

**Pass criteria**
- Descriptors render correctly for core tools.
- Results are normalized; existing behavior unchanged.
- Model can still read/write/bash without failures.

---

## Phase 2: BM25 tool discovery

**What**
1. Replace `search_tools` keyword scoring with an indexed BM25 catalog.
2. Index fields: name, aliases, summary, description, schema keys/descriptions, examples, capability tier, family, source.
3. Keep `select:name` exact promotion.
4. Discovery returns ranked matches; model can then call discovered tools normally.
5. Add several discoverable tools that are not in the core set: `glob`, `eval`, `apply_patch_edit`, `search_files`.

**Small A/B smoke test**
```text
Search for a tool that can list files matching a glob pattern, then use that tool to list all .md files in the workspace root.
```

**Pass criteria**
- `search_tools` returns `glob` as top match.
- Model succeeds in finding and using `glob`.
- No synthetic blocks.

---

## Phase 3: `apply_patch` edit mode

**What**
1. Add a new discoverable tool `apply_patch_edit` (or a `mode: apply_patch` on `file_edit`).
2. Support unified-diff-style patches that can modify multiple files in one call.
3. Provide parser, matcher digest, and hashline projection.
4. Keep `file_edit` as the fast, primary path.
5. Add post-write diagnostics (lint/TSC) and snapshot metadata that comes back as advisory info.

**Small A/B smoke test**
```text
Apply the following patch across the workspace:
- Replace every occurrence of "TODO" with "DONE" in README.md and AGENTS.md.
Use a single tool call if possible.
```

**Pass criteria**
- Patch applies cleanly to both files in one call.
- Post-write diagnostics returned as advisory only.
- No rollbacks unless model explicitly requests preview mode.

---

## Phase 4: `glob` and `eval` tools

**What**
1. Add a dedicated fast `glob` tool (no shell invocation).
2. Add an optional discoverable `eval` tool for low-overhead JS/Python/JSON snippets and AST probes.
3. Ensure both return structured normalized results.
4. Add capability metadata so model knows when to prefer `glob` over `bash find` and `eval` over bash one-liners.

**Small A/B smoke test**
```text
Without using bash, list all .ts files under src/tools and count them using an eval tool.
```

**Pass criteria**
- `glob` returns all matching `.ts` files.
- `eval` computes the count correctly.
- Zero bash calls for this task.

---

## Phase 5: `job` facade over background work

**What**
1. Add a `job` tool that unifies:
   - async bash via `isBackground: true`
   - existing `read_background_output`
   - `signal_process`
   - `write_to_process`
2. Provide list/poll/cancel operations in one call shape.
3. Return normalized job status/results.
4. Keep existing process tools for backward compatibility.

**Small A/B smoke test**
```text
Start a tiny HTTP server (python3 -m http.server 8765) in the background, poll it with curl-like check, then stop it using the job tool.
```

**Pass criteria**
- `job` starts, polls, and stops the server.
- No bash `&`/job-control backgrounding needed.
- Server lifecycle complete.

---

## Phase 6: AST grep / LSP-style diagnostics

**What**
1. Add discoverable `ast_grep` for symbol-aware search.
2. Add deferred/post-write diagnostics for file edits and writes (TSC, lint).
3. Diagnostics returned as advisory result metadata, never blocking the write.
4. Optional `dry_run` mode for `apply_patch_edit` and `file_edit` when explicitly requested.

**Small A/B smoke test**
```text
Find all function declarations named "handleError" across the codebase using the AST search tool, then run the diagnostics tool to see if any edited files from previous phases have TypeScript issues.
```

**Pass criteria**
- `ast_grep` returns matches.
- Diagnostics tool runs and reports status advisory.
- No writes are rolled back automatically.

---

## Phase 7: Full A/B regression — no-Docker RepoReaperlot prompt

**What**
Run the same prompt used for v0.1.3 verification and compare.

**Prompt file:** `/tmp/reaper-task-repopilot-nodocker-prompt.md`

**Comparison metrics**
- Model calls
- Tool calls by tool name
- Failed results and error codes
- Synthetic blocks (must remain 0)
- `pnpm build` pass/fail
- `pnpm test` pass/fail
- API smoke test pass/fail
- Wall-clock duration

**Pass criteria**
- At least as good as v0.1.3 on all of the above.
- No regressions in natural stop behavior.

---

## General rollout rules

1. **One phase at a time.** Do not start phase N+1 until phase N smoke test passes.
2. **Green signal required.** After each phase plan is shown, wait for explicit go-ahead before implementing.
3. **Staged commits.** Each phase gets its own commit under `docs/dev/roadmap-v0.1.4/` with test evidence.
4. **Run artifacts.** Every A/B smoke test is saved under `logs/versions/v0.1.4-phase-N-<description>/`.
5. **Provider.** Use `nuralwatt2` / `kimi-k2.6-fast` for all A/B runs unless otherwise specified.
6. **Honest metrics.** Report real failures and do not overclaim success.

---

## Out of scope for v0.1.4

- Subagent system redesign (removed in v0.1.3, targeted for a later release).
- MCP system (removed in v0.1.3, will be normalized later, not reintroduced now).
- Browser/computer control improvements.
- GitHub/web_search overhauls.
- Memory/skill system redesign.

---

## Expected efficiency gains vs v0.1.3

- Fewer full tool schemas in context (BM25 + discoverable tools).
- Less repeated file reading (snapshot metadata + advisory stale checks).
- More successful edits in fewer turns (`apply_patch`, hashline, AST guardrails).
- Less bash overuse for file discovery (`glob`) and one-off probes (`eval`, `ast_grep`).
- Better async background command ergonomics (`job`).
- Cleaner context compaction via `useless` and structured `details`.
