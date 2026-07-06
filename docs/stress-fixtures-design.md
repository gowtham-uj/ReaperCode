# Reaper Context-Management Stress Fixtures — Design

Five worst-case stress fixtures for exercising Reaper's context compaction
machinery (shake pruning + spillover + bash output persistence + file-read
caching). Each fixture is fully concrete: exact file paths, exact sizes,
exact prompt text, exact metrics to assert.

## 0. Engineering numbers these fixtures target

Pulled from the current source tree (June 2026). Fixture sizes are chosen
to **land in the worst-case band of these constants** — large enough to
trigger the mechanism, small enough that the model can still finish.

| Mechanism                 | Source location                                  | Constant                                                                  |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Shake trigger             | `src/context/shake.ts:30`                        | `SHAKE_TRIGGER_PCT = 50` (trigger at 50% of `softCap`)                    |
| Soft cap (default)        | `src/runtime/engine.ts:1032`                     | `getBoot().state.tokenBudget?.softCap ?? 270_000`                         |
| Shake protect window      | `src/context/shake.ts:24`                        | `PROTECT_WINDOW_CHARS = 12_000` (~3,000 tokens of recent results)         |
| Shake minimum savings     | `src/context/shake.ts:21`                        | `MIN_SAVINGS_CHARS = 100`                                                 |
| Spillover threshold       | `src/tools/tool-result.ts:99`                    | `SPILLOVER_THRESHOLD_BYTES = 8_192`                                       |
| Spillover artifact path   | `src/tools/tool-result.ts:120`                   | `.reaper/spillover/<toolCallId>.log`                                      |
| Bash persist threshold    | `src/tools/bash/constants.ts:4`                  | `PERSIST_THRESHOLD_CHARS = 30_000`                                        |
| Bash preview size         | `src/tools/bash/constants.ts:5`                  | `PREVIEW_SIZE_CHARS = 1_200`                                              |
| Bash artifact path        | `src/tools/bash/result.ts:67`                    | `<workspace>/.reaper/artifacts/bash/<id>.txt` (also `logPath` in result) |
| Shake event log           | `src/runtime/engine.ts:1036`                     | `trajectory.jsonl` → `kind: "context_shake"`, fields `shaken_results`, `saved_chars` |

**Worst-case band chosen for fixtures**: ~100K – 250K estimated chars per
turn, which sits in the 12.5K – 31K token range. That's past the shake
trigger on the default softCap (135K tokens) but still leaves room for
many turns of compaction pressure without forcing PTL/overflow.

Char-budget heuristic used everywhere: `tokens ≈ chars / 4`.

---

## How to run any fixture

```bash
cd /workspace/reapercode-main
WORKSPACE=/tmp/reaper-stress-<fixture-name>
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE/benchmarks/<fixture-name>"
cp -R "benchmarks/<fixture-name>"/* "$WORKSPACE/benchmarks/<fixture-name>/"

npx tsx scripts/run-reaper.ts exec run \
    --workspace "$WORKSPACE" \
    --provider nuralwatt2 \
    --model   kimi-k2.6-fast \
    --prompt-file "$WORKSPACE/benchmarks/<fixture-name>/task_prompt.md" \
    --json | tee "$WORKSPACE/reaper-result.json"
```

The runner writes:
- `reaper-result.json` — final `ExecRunnerResult` (status, assistantMessage, toolResults, trajectoryPath, events, durationMs, notices).
- `<workspace>/.reaper/runs/<runId>/trajectory.jsonl` — per-event JSONL stream; filter for `kind == "context_shake"` to see shake events, or `kind == "tool_result"` to count tool calls.
- `<workspace>/.reaper/spillover/<toolCallId>.log` — artifacts from spillover (any tool result > 8,192 bytes).
- `<workspace>/.reaper/artifacts/bash/<id>.txt` — bash outputs that exceeded the 30K-char persist threshold.

---

## Fixture 1 — `read-then-act-mid-compact`

**Compaction exercise**: shake replaces a *still-relevant* file_read result
with a placeholder mid-edit. Tests that the placeholder is precise enough
that the model can recover (or that shake correctly skips a result the
model still needs).

### Workspace

```
$WORKSPACE/benchmarks/read-then-act-mid-compact/
├── task_prompt.md         (~1 KB)
└── payload/
    └── ledger.jsonl       (TARGET: ~110,000 chars ≈ 27,500 tokens)
```

`ledger.jsonl` is a JSONL of 600 fictional accounting entries. Each line:
```json
{"id":"L-0001","date":"2026-01-02","account":"4110-CUST-A","debit":1042.18,"credit":0,"memo":"Invoice 7781 settled"}
```

Every 50th entry carries a unique hidden marker:
- L-0050 → `"marker":"NEEDLE_5K_TOKEN_OFFSET_42"`
- L-0100 → `"marker":"NEEDLE_10K_TOKEN_OFFSET_77"`
- L-0150 → `"marker":"NEEDLE_15K_TOKEN_OFFSET_13"`
- … etc., 11 needles spaced through the file.

Expected file size: **~110,000 chars**, **~27,500 tokens**, **600 lines**.

### Prompt (verbatim, in `task_prompt.md`)

```markdown
# Reaper Stress Test — Read-Then-Act Mid-Compaction

You are stress-testing Reaper's shake pruning. Follow these steps IN ORDER
and do not skip any.

1. Use `file_view payload/ledger.jsonl` (default 500-line window) to read
   the file.
2. Scroll forward with `file_scroll` (down, 500) until you have seen the
   whole file. Each scroll call returns ~125 tokens of inline context.
3. After the third `file_scroll` call, the conversation is large enough
   that Reaper's shake pass will fire and the very first `file_view`
   result will likely be replaced with a `[file_view: completed, N bytes]`
   placeholder.
4. Create `out/needle-report.json` with shape:
   ```json
   {
     "markers_found": ["NEEDLE_5K_TOKEN_OFFSET_42", ...],
     "markers_missing": [...],
     "lines_seen": 600,
     "shake_observed": true | false
   }
   ```
5. Finish naturally with a final message that states whether you saw any
   `[file_view: ...]` or `[file_scroll: ...]` placeholders appear in
   later turns (a tell that shake ran between turns).

You MUST keep scrolling until you have seen line 600. Do not stop early.
If a `file_scroll` returns a placeholder instead of new lines, re-read
that section with a fresh `file_view path/to/ledger.jsonl offset=...`.
```

### What success looks like (assertable)

- `trajectory.jsonl` contains **≥ 1 `kind: "context_shake"` event**
  with `shaken_results >= 1` and `saved_chars > 100`.
- The placeholder the model *sees* on the next turn is exactly:
  `[file_view: completed, <bytes> bytes]` or `[file_scroll: completed, <bytes> bytes]`
  (per `pruneReplacement` in `src/tools/tool-result.ts:150`).
- `out/needle-report.json` exists, parses as JSON, and
  `markers_found.length === 11`.
- `assistantMessage` (final) mentions "placeholder" or `[file_` at least
  once.
- Total `events` count stays under ~50 (no runaway PTL loops).

### What failure looks like

- `status === "aborted"` or `"failed"` — engine couldn't recover.
- Model re-reads `ledger.jsonl` from scratch after the shake (≥ 1 extra
  `file_view` call with `offset=1`), proving the placeholder wasn't
  enough. (Failure is *recoverable* but indicates placeholder loss.)
- `markers_missing.length > 0` — model lost track of content because the
  placeholder dropped structural information. This is a real
  correctness bug, not a perf regression.
- PTL error visible in `notices` array (`PTL: prefix truncated…`).
- No `context_shake` events emitted at all → fixture didn't hit the
  trigger; bump the file size by 20% and re-run.

---

## Fixture 2 — `reread-huge-file`

**Compaction exercise**: prove the file-read cache (mtime + offset
deduplication) prevents the same file from being inlined into context
more than once across repeated reads.

### Workspace

```
$WORKSPACE/benchmarks/reread-huge-file/
├── task_prompt.md         (~1 KB)
└── payload/
    └── biglog.txt         (TARGET: ~200,000 chars ≈ 50,000 tokens)
```

`biglog.txt` is a deterministic but plausibly-structured 50K-token log:
```
=== BIG LOG v1 ===
line 00001 :: seq=1 event=boot id=beacon-7f3c  ts=1717600000
line 00002 :: seq=2 event=auth.user id=user-001 ts=1717600001 role=admin
...
line ~50000 :: seq=50000 event=shutdown id=beacon-7f3c ts=1717605000 reason=clean
```

Expected file size: **~200,000 chars**, **~50,000 tokens**, **~50,000 lines**.

A small **needle** at exactly line 12,345: `MAGIC_TOKEN_REREAD_12345`.

### Prompt (verbatim)

```markdown
# Reaper Stress Test — Repeated Rereads of Huge File

You are exercising the file-read cache (mtime+offset dedup). Do EXACTLY
this:

1. Call `file_view payload/biglog.txt` to read the first 500 lines.
2. Without modifying the file, call `file_view payload/biglog.txt`
   **four more times** (total 5 reads, same path, no offset).
3. After all 5 reads, call `file_find` on `MAGIC_TOKEN_REREAD_12345`
   to locate the needle.
4. Write `out/reread-report.json`:
   ```json
   {
     "reads_attempted": 5,
     "cache_hits_observed": 0,
     "magic_token_line": 12345,
     "file_size_bytes": 200000
   }
   ```
5. Final assistant message: report how many of the 5 file_view calls
   you believe returned the full inline content vs a stub/placeholder.

Do NOT modify biglog.txt. Do NOT loop with shell. Each read must be a
distinct tool call.
```

### What success looks like

- `trajectory.jsonl` shows exactly **5 `file_view` tool_call events**.
- The 4 reads after the first either:
  (a) return the cached body inline (same content repeated), OR
  (b) return a "stub"/"unchanged since <mtime>" indicator showing
      Reaper's cache recognized the file as unchanged.
- `assistantMessage` reports `cache_hits_observed >= 1`.
- `out/reread-report.json` is valid JSON, `magic_token_line === 12345`.
- **Total inline body bytes** counted across all 5 file_view tool_result
  events in the trajectory is **≤ 5 × file_size** but ideally close to
  **1 × file_size** (cache worked). The success threshold to assert:
  `<= 1.2 * file_size_bytes` total inline content across the 5 reads.

### What failure looks like

- All 5 reads inline ~200K chars → 1M chars in context. **Cache is
  broken.** The fixture is specifically here to detect this.
- `file_view` returns "ENOENT" on the second read — cache key collision.
- Model believes `magic_token_line` is something other than 12345,
  proving the *content* was truncated or replaced.
- Model never finds the needle because the cache returned stale bytes
  from a different read.

---

## Fixture 3 — `bash-giant-log-spillover`

**Compaction exercise**: prove the bash output-persistence path
(PERSIST_THRESHOLD_CHARS=30K, PREVIEW_SIZE_CHARS=1,200) keeps the
model productive when a single bash call returns >200K chars.

### Workspace

```
$WORKSPACE/benchmarks/bash-giant-log-spillover/
├── task_prompt.md         (~0.5 KB)
└── payload/               (empty — bash generates the data)
```

The fixture deliberately has **no prebuilt payload**; the prompt
asks the model to generate the giant log itself.

### Prompt (verbatim)

```markdown
# Reaper Stress Test — Giant Bash Output + Spillover

You are stress-testing bash output persistence + spillover. Do this:

1. Run `bash`:
   ```
   bash -lc "for i in $(seq 1 12000); do echo \"line $i :: value=$(printf '%064d' $i) hash=$(openssl rand -hex 8) status=ok\"; done"
   ```
   Expected stdout length: ~840,000 chars (~210,000 tokens).
2. The runtime should persist the full output to
   `.reaper/artifacts/bash/<id>.txt` and return only the first ~1,200
   chars inline, plus a `logPath` field.
3. After you see the preview, use `read_file` (or `file_scroll`) on the
   `logPath` to find the line containing the token `value=0000000000000000000000000000000000000000000000000000000000004242`.
   (That value is `printf '%064d' 1060`. The hex hash on that line will
   be random; identify by `value=000…4242`.)
4. Write `out/spillover-report.json`:
   ```json
   {
     "bash_persist_path": "<the path the bash result reported>",
     "preview_chars_seen": 1200,
     "full_output_bytes": 840000,
     "needle_line_identified": true,
     "spillover_artifact_present": true
   }
   ```
5. Final message: state whether you had to read the persisted log file
   separately to find the needle, or whether the inline preview was
   sufficient.
```

### What success looks like

- A `bash` tool_call event in `trajectory.jsonl` with result containing
  `logPath` and `persistedOutputSize > 30_000`.
- An artifact file at `<workspace>/.reaper/artifacts/bash/<id>.txt`
  with size **≥ 800,000 bytes** (assert via `stat`).
- The inline `stdout` field in the bash tool_result is **≤ ~1,500 chars**
  (preview + ellipsis).
- Model produces `out/spillover-report.json` with
  `needle_line_identified === true`.
- Total `events` count ≤ 25 — no PTL explosion.
- Single `context_shake` event allowed (large preview + ack eats
  ~3K tokens combined); 0 events is also fine.

### What failure looks like

- Bash result returns the full 840K chars inline → `persistedOutputSize`
  absent or `0` → persistence path skipped. **The whole point of the
  fixture.**
- `logPath` field missing on the result.
- Model never writes `out/spillover-report.json` because it can't find
  the needle — context window overflowed before it could grep.
- PTL error in notices: model hit hard cap trying to keep full log in
  context.

---

## Fixture 4 — `many-write-acks`

**Compaction exercise**: 50+ `write_file` acks in a row. Each ack is
~30 bytes. Total ≈ 1,500 chars — *too small* to trigger shake on its
own. The fixture is paired with a giant file-read so the *combined*
context crosses the shake threshold, then asserts that the
write-ack placeholders are aggressively compressed and **cache
prefix is preserved** (no premature tool-call-id rewriting).

### Workspace

```
$WORKSPACE/benchmarks/many-write-acks/
├── task_prompt.md
└── payload/
    └── big-readme.txt     (~120,000 chars ≈ 30,000 tokens)
```

`big-readme.txt`: 30K-token deterministic README with a needle
`ACCOUNT_ID=ACME-998877` at the top, and the string
`CACHE_PREFIX_CANARY=CACHE-OK-XYZZY` somewhere at line 200.

The prompt asks the model to first read the README, then create 50
small files `out/chunk-XX.txt` each containing a single line copied
from the README.

### Prompt (verbatim)

```markdown
# Reaper Stress Test — Many Write Acks + Cache Continuity

You are testing that shake prunes write_file acks aggressively without
busting the model's prompt-cache prefix.

Steps:

1. `file_view payload/big-readme.txt` (full 500-line window).
2. `file_scroll` (down, 500) twice to see the whole file.
3. Confirm `ACCOUNT_ID=ACME-998877` is on line 1 and that you can see
   the canary string `CACHE_PREFIX_CANARY=CACHE-OK-XYZZY` at line 200.
4. Create 50 files using `write_file`:
   - `out/chunk-00.txt` through `out/chunk-49.txt`
   - each containing exactly one non-empty line copied verbatim from a
     distinct section of the README
5. After all 50 writes, write `out/acks-report.json`:
   ```json
   {
     "files_written": 50,
     "account_id_seen": "ACME-998877",
     "canary_seen": true,
     "ack_chars_before_shake": 1500,
     "ack_chars_after_shake": 250
   }
   ```
6. Final message: report whether any `write_file` result was replaced by
   a `[write_file: <path>]` placeholder by the time you were halfway
   through the writes.
```

### What success looks like

- 50 distinct `write_file` tool_call events in `trajectory.jsonl`.
- After write #30 or so, **shake fires** (`context_shake` events appear)
  and the early `write_file` results in the trajectory are *short
  placeholders* (`[write_file: out/chunk-00.txt]`, etc., ~30 chars
  each). Verify by `grep -c '"\[write_file:' trajectory.jsonl` ≥ 30.
- `out/acks-report.json` exists and parses; `files_written === 50`.
- **No PTL errors**, no aborted status. The run finishes cleanly.
- Total inline content of all write_file tool_results in trajectory
  ≤ ~3,000 chars (50 × ~30 placeholder + a few unpruned late ones).
  Without shake this would be ~50 × original ack size — much higher.

### What failure looks like

- Shake leaves write_file results inline → trajectory shows full ack
  bodies → context bloat → PTL on later turns.
- Model loses track of which files it has written (`chunk-NN.txt`
  numbering goes wrong) — shake reordered or dropped an assistant
  tool-call block.
- `context_shake` event claims `shaken_results > 0` but the trajectory
  shows write_file results still inline (placeholder-not-applied bug).
- Model repeats an already-written filename because the previous ack
  was shaken *and* the tool_call arguments were also shaken, breaking
  the tool_call ↔ tool_result pairing invariant.

---

## Fixture 5 — `plan-then-many-edits` (the hardest case)

**Compaction exercise**: the model emits a long planning assistant
message (multiple paragraphs describing 100 small edits), then
executes them across 100 tool calls. The shake pass happens *during*
the edit batch, and the fixture asserts that:

(a) the planning assistant message survives shake (it isn't a tool
    result, so by spec shake should NOT touch it),
(b) the early edit acks get shaken as expected,
(c) the model still completes the planned sequence (no edit skipped,
    no edit duplicated, no off-by-one).

### Workspace

```
$WORKSPACE/benchmarks/plan-then-many-edits/
├── task_prompt.md
└── payload/
    └── target.c           (TARGET: ~3,000 chars ≈ 750 tokens)
```

`target.c` is a short synthetic C source file (~80 lines) with 100
commented markers `/* EDIT_POINT_<NNN> */` scattered through it.
Each marker is at a distinct line.

### Prompt (verbatim)

```markdown
# Reaper Stress Test — Long Plan + 100 Edits

You are testing that Reaper preserves the relationship between a long
planning assistant turn and the many small edits it spawns, even after
shake prunes intermediate tool results.

Steps:

1. Read `payload/target.c` with `file_view`.
2. In your NEXT assistant turn (no tool calls), produce a written plan
   that lists ALL 100 edits in order: for each marker
   `/* EDIT_POINT_NNN */`, state the line number and the exact
   replacement string you will insert. The plan must be ≥ 4,000 chars
   of prose and lists.
3. Then execute the plan by calling `file_edit` 100 times, once per
   marker. Each call replaces `/* EDIT_POINT_NNN> */` with
   `/* EDIT_POINT_NNN :: fixed */`.
4. After all 100 edits, run `bash`:
   `grep -c "EDIT_POINT_.* :: fixed" payload/target.c`
   and verify the count is exactly 100.
5. Write `out/edit-report.json`:
   ```json
   {
     "edits_planned": 100,
     "edits_attempted": 100,
     "edits_succeeded": 100,
     "duplicate_edits": [],
     "skipped_edits": [],
     "planning_message_intact": true
   }
   ```
6. Final message: confirm the plan survived any compaction.
```

### What success looks like

- `trajectory.jsonl` shows **exactly 100 `file_edit` tool_call events**.
- `grep -c "EDIT_POINT_.* :: fixed" payload/target.c` returns **100**.
- `out/edit-report.json` reports `edits_succeeded === 100`, empty
  `duplicate_edits` and `skipped_edits`.
- At least one `context_shake` event with `shaken_results >= 5`
  (shake fires sometime around edit 30–50 once acks accumulate).
- The **planning assistant message** is still present in the final
  conversation snapshot (assert by reading
  `<workspace>/.reaper/runs/<runId>/context.jsonl` and locating a
  long assistant turn ≥ 4,000 chars immediately preceding the file_edit
  bursts).
- `status === "completed"`.

### What failure looks like

- The planning assistant message is gone from `context.jsonl` (shake
  somehow trimmed it — implementation bug, since shake targets only
  `role: "tool"` messages per `src/context/shake.ts:304`).
- Duplicate edits: model re-plans because the plan was shaken.
- Skipped edits: model lost track of the cursor.
- `edits_succeeded < 100` while `edits_attempted === 100` → file_edit
  failed for some markers (likely because shake replaced an earlier
  `file_view` with a placeholder that didn't include the marker
  context).
- More than 100 `file_edit` calls → shake replay glitch.

---

## (Bonus) Fixture 6 — `cache-breaking-bash-plus-reread`

Not in the 5-required set; documented for completeness. Skippable if
time is tight.

**Compaction exercise**: a bash command whose output changes every
run (`date`, `openssl rand`, `uuidgen`) immediately followed by a
`file_view` of a stable file. Tests that shake is stable across
variable bash output (no prompt-cache invalidation due to bash churn).

### Workspace

```
$WORKSPACE/benchmarks/cache-breaking-bash-plus-reread/
├── task_prompt.md
└── payload/
    └── stable.md          (~2,000 chars, NEVER modified)
```

### Prompt (verbatim)

```markdown
# Reaper Stress Test — Cache-Breaking Bash + Stable Re-read

1. Run `bash -lc "date; uuidgen; openssl rand -hex 16"` three times in
   a row (three separate bash calls). Each call returns a different
   output, so the inline context churns.
2. After the third bash call, call `file_view payload/stable.md` and
   confirm the file contents are unchanged.
3. Verify Reaper's output for the file_view is a stable result
   (placeholder OR full body — but the placeholder should NOT include
   the bash output).
4. Write `out/cache-report.json` listing each bash stdout and the
   stable.md first 200 chars.
```

### What success looks like

- 3 distinct `bash` tool_call events with 3 different `stdout` values.
- 1 `file_view` tool_call event for `payload/stable.md` whose result
  is *not* contaminated by the random bash output.
- If shake fires (it likely won't — context is too small), the
  placeholders for the 3 bash calls do not corrupt the file_view
  result.

### What failure looks like

- The file_view result includes the bash output by mistake
  (hallucination).
- Shake replaces the file_view result with a bash-flavoured
  placeholder (tool-name lookup bug in
  `src/context/shake.ts:148 findToolNameForCall`).
- Model refuses to verify stable.md because the prior bash output
  confused it about state.

---

## Master assertion protocol

After every fixture run, the assertion harness (a future `scripts/run-stress.sh`)
should:

```bash
# 1. Status check
jq -e '.status == "completed"' "$WORKSPACE/reaper-result.json"

# 2. No PTL / no abort
jq -e '.notices | map(select(.kind == "error" or .kind == "abort")) | length == 0' \
    "$WORKSPACE/reaper-result.json"

# 3. Shake events (where expected)
TRAJ="$WORKSPACE/.reaper/runs/$(jq -r .trajectoryPath "$WORKSPACE/reaper-result.json" | xargs basename)/trajectory.jsonl"
# (or whichever path the engine writes — confirm by ls)
grep '"kind":"context_shake"' "$TRAJ" | wc -l   # ≥ 1 for fixtures 1, 4, 5

# 4. Spillover artifact (fixture 3)
[ -f "$WORKSPACE/.reaper/artifacts/bash/"*".txt" ] && \
  SIZE=$(stat -c %s "$WORKSPACE/.reaper/artifacts/bash/"*".txt") && \
  [ "$SIZE" -gt 800000 ]

# 5. Fixture-specific output file exists & parses
jq -e . "$WORKSPACE/out/<fixture>-report.json"

# 6. Inline-content metric (fixture 2)
# Sum the file_view tool_result content lengths in trajectory; assert <= 1.2 * file_size
```

## Why these 5

Each one targets a **distinct** compaction code path:

| # | Fixture                       | Targets                                     |
| - | ----------------------------- | ------------------------------------------- |
| 1 | read-then-act-mid-compact     | Shake during a still-relevant tool result   |
| 2 | reread-huge-file              | File-read cache (mtime + offset dedup)      |
| 3 | bash-giant-log-spillover      | Bash output persistence + spillover artifact|
| 4 | many-write-acks               | Shake of repeated write_file acks            |
| 5 | plan-then-many-edits          | Shake preserves non-tool assistant content  |

Together they cover: `src/context/shake.ts` (all paths), `src/tools/tool-result.ts`
(normalize/spillover), `src/tools/bash/{execute,result}.ts` (persistence), and
the file-view cache layer in `src/tools/executor.ts`. They fail in *different*
ways, so a regression in any single subsystem will surface as a different
fixture's failure mode rather than collapsing into one ambiguous error.