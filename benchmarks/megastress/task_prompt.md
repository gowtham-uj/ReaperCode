# Megastress A/B Test — Reaper Context Engineering

You are inside `/workspace/reapercode-main/benchmarks/megastress/payload/`.
This is a fresh empty repository except for the files described below.
Your goal is to complete ALL nine steps in order. Do not skip steps.

## Files in the workspace

- `src/big_module.ts` — 5000 lines with 100 EDIT_POINT_<NNN> markers. Each
  marker must be replaced with its assigned value from
  `payload/logs/manifest.json`. Read the manifest first.
- `logs/manifest.json` — the EDIT_POINT_<NNN> → value mapping.
- `logs/events-{01..04}.jsonl` — 4 giant JSON-lines log files (~400 KB
  each). You will analyze them in step 3.
- `docs/architecture/overview.md`, `docs/product/spec.md`,
  `docs/backend/indexing.md`, `docs/ops/observability.md` — these
  contain the **hidden requirements**. You must read all four.

## Workflow

### Step 1 — Read the manifest and confirm
Use `file_view` (NOT `bash cat`) on `logs/manifest.json` to read it.
Confirm you can see all 100 EDIT_POINT_<NNN> entries.

### Step 2 — Read the four hidden requirement docs
Use `file_view` on each of the four docs/*.md files. Do NOT use
`bash cat` to read them — the system prompt requires `file_view`.

### Step 3 — Analyze the four giant log files
For each `logs/events-NN.jsonl`, run:
  bash -c "wc -l logs/events-NN.jsonl"
Then run a count-by-level breakdown:
  bash -c "jq -r '.level' logs/events-NN.jsonl | sort | uniq -c"
Write a single `logs/analysis.json` file with shape:
  { "events-01.jsonl": {"INFO": N, "WARN": N, ...}, ... }

### Step 4 — Apply all 100 EDIT_POINT replacements
For each EDIT_POINT_<NNN> marker in `src/big_module.ts`, use `file_edit`
to replace the line containing `// EDIT_POINT_<NNN>` with the value
from the manifest. The model line:
  // EDIT_POINT_001
becomes:
  // EDIT_POINT_001 :: VAL_001

You will make 100 file_edit calls. After all of them, run:
  bash -c "grep -c 'EDIT_POINT_.* :: ' src/big_module.ts"
and verify the count is 100.

### Step 5 — Build a tiny fixture and verify
Create `fixtures/hello.ts` with:
  export const hello = 'world';
Then:
  bash -c "ls -la fixtures/"

### Step 6 — Use grep_search to confirm every hidden requirement was found
For each of the 8 hidden requirements (HR1..HR8), run:
  grep_search "Hidden requirement <N>" docs/
and verify the count is 8 unique matches across the four docs files.

### Step 7 — Memory search
Call the `search_memory` tool with:
  { "query": "what have I done so far in this session" }
Report the count of hits returned.

### Step 8 — Write the final summary
Write `artifacts/final_report.md` containing:
- Number of EDIT_POINT replacements applied (must be 100)
- Number of log files analyzed (must be 4)
- Number of hidden requirements found (must be 8)
- First 5 file_edit ack lines (the placeholders shake should replace)
- The bash count-by-level output for each log file
- Total tool calls made

### Step 9 — Declare completion
Stop calling tools. Write a final assistant message that contains:
- Files created
- Files modified
- Total model turns used
- Total tool calls used
- Total chars saved by shake (from the trajectory log)
- Total context-warning_state events seen
- Any errors encountered

## Constraints

- Do NOT use `bash cat` to read any file. Use `file_view`, `file_scroll`,
  `grep_search`, or `search_tools` only. The system prompt forbids
  heredoc-style reads.
- All bash commands must use `bash -c "..."` syntax.
- After every 5 file_edit calls, briefly summarize what you have done
  so far in the assistant message.
- This is intentionally long. Do not loop. Do not get stuck. If you
  fail a tool call twice, switch to a different tool.

Begin now.
