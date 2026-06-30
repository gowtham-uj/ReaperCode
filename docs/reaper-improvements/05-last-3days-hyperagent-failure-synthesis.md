# Last 3 Days Reaper Agent Run Failure Analysis & Proposed Solutions

**Scope:** 2026-06-12 to 2026-06-14 HyperAgent (`claude-opus-4-8`) terminal-bench runs  
**Analysis method:** Parallel read-only subagent swarm on run logs, source code, and workflows  
**Confidence:** High (provider-level signals are clean; failures are orchestration/task-strategy related)

---

## 1. Executive Summary

Across the last 3 days of Reaper agent runs using the HyperAgent provider, **no provider auth, HTTP, or stream-timeout failures were observed**. Every logged HyperAgent call returned `ok: true`. The failures are instead **harness-level agent timeouts and task-level strategy errors**:

| Task | Runs | Resolved | Dominant failure |
|------|------|----------|------------------|
| `3d-model-format-legacy` | 12 | 1 | `AGENT_TIMEOUT` after 1200 s |
| `ancient-puzzle` | 6 | 3 | extraction / Docker port conflict / harness crash |

The single successful `3d-model-format-legacy` run used a concrete, reproducible strategy: install `g++-multilib`, compile with `-m32`, preserve the original 32-bit on-disk struct layout, and write a single CLI converter accepting `<input.mdf> <output.json>`. All other runs wasted budget rediscovering the 32-bit ABI requirement or got stuck behind the boundary-preflight gate.

For `ancient-puzzle`, successful runs often resolved only because the artifact happened to be correct when the 3-attempt completion gate exhausted—not because the agent emitted a clean `complete_task`.

---

## 2. Observed Failure Modes

### 2.1 `3d-model-format-legacy` — agent timeout (10 of 11 runs)
- Failure mode in `results.json`: `AGENT_TIMEOUT` at 1200.0 s.
- Root issue: the 2007 MDF library uses unions of pointers and `int` offsets (`TMdfMesh`, `TMdfAnimation`, `TMdfTimeline` in `mdftypes.h`). On x86_64 the pointer member is 64-bit, but the on-disk format is 32-bit. Agents that compiled natively got segfaults, garbage data, or ASAN errors and then looped in read-only diagnostics / recovery.
- The only passing run (`diagnose-3d-enforced-boundary-20260613`) explicitly chose `-m32` + `g++-multilib` after a boundary probe and finished in ~768 s.
- Several runs also failed because the converter CLI treated the second argument as an output directory rather than a file path; the hidden CMake test invokes `mdf2json <input.mdf> <output.json>` and checks `converted_models/temp/<name>.json`.

### 2.2 `ancient-puzzle` — semantic extraction failure
- In `ancient-puzzle-reliability-after2-20260612T023405Z`, the agent sent the correct incantation (`ECHOES-OF-CYPRESS`) to the decryptor service. The service wrote the correct secret (`What is etched, endures.`) to `/app/results.txt`, but the agent then **overwrote `results.txt` with the JSON response wrapper text** (`The ancient mechanism recognizes your incantation...`).
- The passing runs (`fixture-fixed`, `reliability-after`, `reliability-after5`) passed largely because the artifact was already correct when the completion gate gave up, not because the model emitted a well-formed `complete_task`.

### 2.3 `ancient-puzzle` — Docker host port conflict
- `ancient-puzzle-reliability-after4-20260612T025916Z` failed because `docker-compose.yaml` binds the decryptor to host port `8090:8090`, and a stale container from a prior run still held the port.

### 2.4 `ancient-puzzle` — harness interruption
- `ancient-puzzle-reliability-after3-20260612T024910Z` stopped after starting the asciinema recording and never wrote `suite-state.jsonl`, suggesting the runner process crashed or was OOM-killed.

### 2.5 `completion_gate_exhausted`
- Multiple runs hit the 3-attempt completion gate limit even though task artifacts were present and parser-ready (`diagnose-3d-general-reliability-20260613`, `diagnose-3d-hyperagent-opus-20260613`, and some `ancient-puzzle` runs).

---

## 3. Source-Code / Workflow Root Causes

### 3.1 Boundary-preflight gate can block indefinitely
**File:** `src/runtime/boundary-preflight.ts`  
**Issue:** `guardBoundaryPreflightToolCalls` blocks source mutations and broad reads until the shell output contains exact tokens:
- `BOUNDARY_EVIDENCE=<measured comparison>`
- `BOUNDARY_COMPOSITE_CHECK=<measured external composite vs runtime composite>`
- a non-unknown `BOUNDARY_DECISION=...`
- `BOUNDARY_STRATEGY=<specific executable strategy>`

In `3d-final-boundary-strategy-rerun-20260614`, the probe returned `EXIT 1` and the agent never produced the required tokens, consuming the full 1200 s budget on the probe alone.

### 3.2 Simplify-recovery path allows read-only drift
**File:** `src/runtime/engine.ts` (`buildSimplifyRecoveryPrompt`, lines ~10249–10360)  
**Issue:** The recovery prompt says "Produce 1 to 6 concrete tool calls" and "Do not return an empty tool_calls array", but it still permits read-only calls. With no hard forcing function, the model can read the same specs/sources repeatedly until timeout. In `3d-temp-coherent-final-rerun-20260614`, the final ~40 trajectory events were `simplify_recovery` read calls with no `advance_step` or `complete_task`.

### 3.3 Progress guards only catch *identical* read-only batches
**File:** `src/runtime/engine.ts` (`guardRepeatedReadOnlyBatch`, lines 5186–5218; `guardImplementationReadOnlyDrift`, lines 5220–5281)  
**Issue:** A model can avoid `repeated_read_only_batch_blocked` by varying the tool, path, or line range. The signature is too strict; "different combinations of the same context" are not blocked.

### 3.4 `complete_task` is classified as a read tool
**File:** `src/execution/planner.ts` (lines 30–33)  
**Issue:** `classifyToolCall` returns `"read"` for `complete_task`. This lets it run concurrently with other reads and reduces the finalization barrier, contributing to gate-exhaustion cases where the artifact is ready but the run does not cleanly terminate.

### 3.5 Cross-context temporary helpers break in sandboxed runs
**File:** `src/runtime/boundary-preflight.ts` (`guardBoundaryPreflightToolCalls`, lines 134–158)  
**Issue:** A `write_file` to `.reaper/tmp/probe.py` creates the file in the host/workspace view, but `run_shell_command` executes inside the terminal-bench Docker container. The staged file is not visible, so probes like `python3 .reaper/tmp/probe.py` fail with `No such file or directory`. The guard detects this and blocks it, but the agent then has no working path to produce boundary evidence.

### 3.6 HyperAgent provider has parsing and timeout gaps
**Files:** `src/model/providers/hyperagent.ts`, `.pi/extensions/hyperagent-provider.ts`  
**Issues:**
- `parseToolCalls` in the Reaper provider only tries `JSON.parse` and checks `tool_calls`/`toolCalls`; it does not recover PI_CALL lines, markdown-fenced JSON, OpenAI-style function wrappers, or function-style calls. The Pi extension has all of these.
- Primary and fallback models both default to `claude-opus-4-8`, so rotation/fallback does not change the underlying model.
- On any chat error, `HyperAgentClient.run` deletes the per-key thread state, losing in-thread context.
- Default total timeout is 300 s, but aggregate logs show completed HyperAgent calls up to ~367 s.
- `tests/unit/hyperagent-provider.test.ts` is out of sync with recent default changes (`maxThinkingTokens`, `effort`, `fastMode`).

### 3.7 Completion gate is too rigid for hard tasks
**Files:** `src/config/model-config.ts` (lines 66, 171), `src/runtime/engine.ts` (`emitCompletionGateExhausted`, line 437)  
**Issue:** `completionGateMax` defaults to 3. On hard tasks the model may need more verification/termination iterations, especially when the agent is not reliably emitting `complete_task`.

---

## 4. Proposed Solutions

### P0 — Stop timeout bleed on hard legacy tasks

1. **Seed legacy-format tasks with ABI/encoding hints.**  
   For tasks whose spec mentions "legacy proprietary library", "binary format", "2007", "win32", or "custom 3D model format", inject a system hint:  
   > "This task likely involves a legacy 32-bit on-disk struct/layout. Consider compiling with `-m32` (install `g++-multilib` on Linux) or using explicit `int32_t` offsets instead of pointers."

2. **Capture the winning 3d strategy as a verified lesson.**  
   Persist the exact recipe from `diagnose-3d-enforced-boundary-20260613` (multilib install, `-m32`, portable replacements for `ZeroMemory`/`windows.h`, CLI contract `mdf2json <input> <output>`, CMake build) so future runs start from a known-good path rather than rediscovering it.

3. **Relax the boundary-preflight gate when acceptance tests can validate the invariant.**  
   If the task has visible or hidden tests that already check binary layout/output correctness, allow source edits after at most **2 failed probes** or after **N read-only batches** (e.g., 4), rather than requiring exact `BOUNDARY_*` tokens. The tokens are useful but should not be able to dead-lock a run.

4. **Force concrete action in simplify-recovery after read-only drift.**  
   In `buildSimplifyRecoveryPrompt` or the node that invokes it, add a hard rule: after 3 consecutive read-only results without a state-changing action, the engine must either (a) auto-advance to a tiny implementation mini-step, (b) call `request_patch` for a scoped fix, or (c) replan with a smaller bounded step. Reads alone cannot consume the rest of the budget.

### P1 — Fix the completion gate

1. **Accept parser-passed artifacts as completion.**  
   If the independent verification / parser passes and the artifact exists, treat the run as resolved even if the model did not emit `complete_task`. The gate should be a safety check, not a hard requirement for success.

2. **Make `complete_task` a barrier.**  
   In `src/execution/planner.ts`, change `complete_task` classification from `"read"` to `"shell_barrier"` (or add a special `"completion"` kind). This prevents it from being batched with other reads and gives it finalization semantics.

3. **Make `completionGateMax` configurable per task difficulty.**  
   Easy tasks can keep 3; medium/hard tasks should get 5–7 attempts, because they require more verification cycles.

### P2 — Fix sandbox cross-context helpers

1. **Create temp helpers atomically inside one shell command.**  
   When the runtime detects a `.reaper/tmp/` write that will be consumed by a shell command in a sandboxed run, rewrite it as a single `run_shell_command` that uses a heredoc to create and execute the helper. The boundary-preflight guard already suggests this but the engine should do it automatically.

2. **Alternative: copy staged temps into the container.**  
   Before executing a shell command that references `.reaper/tmp/`, ensure the file is copied into the task container's filesystem view.

### P3 — Improve HyperAgent provider robustness

1. **Port parsing logic from the Pi extension.**  
   Move `extractPiCallObjects`, `extractJsonObjects`, `extractFunctionStyleToolCalls`, and `parsePlainToolRequests` from `.pi/extensions/hyperagent-provider.ts` into `src/model/providers/hyperagent.ts` so the Reaper provider can recover PI_CALL lines and markdown-fenced JSON.

2. **Update unit tests.**  
   Fix `tests/unit/hyperagent-provider.test.ts` to match current defaults (`maxThinkingTokens=4096`, `effort=high`, `fastMode=false`, etc.).

3. **Make timeouts configurable per role/task.**  
   Allow `totalTimeoutMs`, `firstEventTimeoutMs`, and `idleTimeoutMs` to be overridden by model profile or task config, and raise the default `totalTimeoutMs` to at least 600 s to match observed Opus 4.8 latency.

4. **Preserve thread context on non-auth errors.**  
   In `HyperAgentClient.run`, only delete the thread key on authentication failures; for transient HTTP/stream errors, retry with the same thread so in-thread context is not lost.

### P4 — Fix ancient-puzzle reliability

1. **Verify artifact contents, not response wrappers.**  
   Add a task-specific post-processor (or general pattern) that, after calling a service that writes an answer file, reads the file directly and ignores the HTTP/JSON wrapper text. For `ancient-puzzle`, the agent should read `/app/results.txt` after the POST and use that value.

2. **Dynamic Docker port allocation.**  
   Modify `docker-compose.yaml` (or the harness) to bind the decryptor to an ephemeral host port and inject the chosen port into the task environment, avoiding stale-port conflicts.

3. **Container cleanup between sequential trials.**  
   Ensure `docker-compose down` (or equivalent) runs before each trial, and add a pre-flight port check that fails fast with a clear message if the port is still occupied.

---

## 5. Suggested Validation Plan

1. **Unit tests:** run `npm test -- tests/unit/hyperagent-provider.test.ts` after updating defaults; expect failures until patched.
2. **Provider parsing test:** add a unit test with PI_CALL lines and markdown JSON to verify `parseToolCalls` recovers them.
3. **3d regression:** rerun `3d-model-format-legacy` with the seeded `-m32` hint and relaxed boundary gate; target ≥80% pass rate.
4. **ancient-puzzle regression:** rerun the reliability suite with artifact-content verification and dynamic ports; target ≥80% pass rate.
5. **Read-only drift regression:** add an integration test that simulates 5 consecutive read-only turns in simplify recovery and asserts the engine forces a concrete action or replan.

---

## 6. Confidence & Risks

- **Confidence in diagnosis:** High. Provider logs are clean; failure modes are visible in `results.json`, `suite-state.jsonl`, and stdout logs.
- **Confidence in P0 solutions:** High. The winning `-m32` strategy is already proven once.
- **Confidence in P1/P2 solutions:** Medium-High. They address observed failure modes but require careful integration to avoid breaking existing passing tasks.
- **Main residual risk:** Relaxing the boundary-preflight gate or completion gate too much could let the agent proceed with an incorrect strategy on other tasks. Changes should be gated by task tags/difficulty and validated on a broader benchmark set.
