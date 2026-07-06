#!/usr/bin/env python3
"""
Build the megastress fixture — a single workload that exercises every
Reaper context-engineering layer simultaneously:

  - Tier 1: file-read cache (re-reading same file), mtime-stub (file
    modified mid-session, must invalidate), normalized envelope pruning
    (large tool results).
  - Tier 2: shake compaction (100+ file_edit acks pile up), PTL self-
    retry if forced.
  - Tier 3: time-based microcompact (many bash tool results over time),
    full summarization (forced by softCap pressure).
  - Tier 4: bash head+tail persistence (giant log files), persistent
    summary storage, named-session journal, memory-search.

Layers forced through workload shape:
  - 100+ MARKER_<NNN> points across 5000-line source files → many
    file_edit acks (shake fodder).
  - 4 huge JSON log files (~400KB each) → bash giant-output spillover.
  - 12 markdown docs containing hidden requirements scattered across
    payload/docs/{architecture,product,backend,ops}/ — model must
    use grep_search / search_tools to find them (retrieval).
  - 1 main 5000-line source file → forces multiple file_scroll calls.
  - Hidden requirement: "after step 7, write a memory_search query
    for what you have done so far" — exercises the search_memory tool.
  - Hidden requirement: "before resuming, run reaper exec run
    --session megastress --continue <prompt>" — exercises named
    persistent session.
"""

import json
import os
import random
from pathlib import Path

WS = Path(__file__).resolve().parent.parent / "benchmarks" / "megastress"
random.seed(2026_07_05)


def main() -> None:
    payload = WS / "payload"
    payload.mkdir(parents=True, exist_ok=True)

    # ── big_module.ts: 5000 lines, 100 EDIT_POINT markers ──────────────
    src = payload / "src"
    src.mkdir(exist_ok=True)
    big = src / "big_module.ts"
    lines = [
        "// big_module.ts — synthetic source for the megastress A/B test",
        "// 100 EDIT_POINT markers; each must be replaced with the assigned",
        "// value (read from payload/logs/manifest.json).",
        "",
        "export interface BigConfig {",
        "  version: string;",
        "  features: Record<string, boolean>;",
        "  limits: Record<string, number>;",
        "}",
        "",
        "export const DEFAULT_BIG_CONFIG: BigConfig = {",
        "  version: '0.1.0',",
        "  features: {},",
        "  limits: {},",
        "};",
        "",
    ]
    marker_lines = {}
    for i in range(1, 101):
        value = f"VAL_{i:03d}"
        marker_lines[f"EDIT_POINT_{i:03d}"] = value
        lines.append(f"// section_{i:03d}: feature {value}")
        lines.append(f"// EDIT_POINT_{i:03d}")
        lines.append(f"export const feature_{i:03d} = 'placeholder_{i:03d}';")
        for filler in range(8):
            lines.append(f"// helper for feature {i} line {filler}")
            lines.append(f"function filler_{i}_{filler}(x: number): number {{ return x + {filler}; }}")
    lines.append("")
    lines.append("// end of file")
    big.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ── manifest.json — the model reads this to learn the values ──────
    logs = payload / "logs"
    logs.mkdir(exist_ok=True)
    manifest = {
        "version": "1.0",
        "description": "EDIT_POINT_<NNN> → assigned value mapping. The model must read this and apply the values to src/big_module.ts.",
        "values": {f"EDIT_POINT_{i:03d}": v for i, v in enumerate(marker_lines.values(), 1)},
        "total_markers": 100,
    }
    (logs / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # ── four giant JSON logs (~400KB each) → bash giant-output spillover ──
    for idx in range(1, 5):
        records = []
        for r in range(2000):
            records.append({
                "id": r,
                "ts": f"2026-07-0{idx}T{r % 24:02d}:00:00Z",
                "level": ["INFO", "WARN", "ERROR", "DEBUG"][r % 4],
                "component": f"component_{r % 50}",
                "message": f"log entry {idx}-{r}: " + ("x" * 50),
                "tags": [f"tag_{r % 7}", f"tag_{(r + idx) % 11}"],
                "metrics": {
                    "latency_ms": (r * 7) % 1000,
                    "queue_depth": (r * 13) % 100,
                },
            })
        log_path = logs / f"events-{idx:02d}.jsonl"
        log_path.write_text(
            "\n".join(json.dumps(r) for r in records) + "\n",
            encoding="utf-8",
        )

    # ── hidden requirements scattered across docs/ ────────────────────
    docs = payload / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "architecture").mkdir(exist_ok=True)
    (docs / "product").mkdir(exist_ok=True)
    (docs / "backend").mkdir(exist_ok=True)
    (docs / "ops").mkdir(exist_ok=True)

    hidden_specs = {
        "docs/architecture/overview.md": [
            "# Architecture Overview",
            "",
            "## Hidden requirement 1 — Incremental Indexing",
            "",
            "The scanner must support incremental indexing: skip files whose SHA256 hash",
            "has not changed since the last index pass, and only re-ingest changed files.",
            "",
            "## Hidden requirement 2 — Summary-prefers-retrieval",
            "",
            "The retrieval engine must prefer summaries over raw files whenever possible.",
            "A summary is typically 10-50× smaller than the raw file and covers the same",
            "ground.",
            "",
            "## General architecture",
            "The system consists of a scanner, parser, summarizer, retriever, and dashboard.",
        ],
        "docs/product/spec.md": [
            "# Product Specification",
            "",
            "## Hidden requirement 3 — Audit Logs",
            "",
            "Every `repomind task` execution must write an audit log entry under",
            ".repomind/audit/<timestamp>.json with the user prompt, model, action list,",
            "and exit status.",
            "",
            "## Hidden requirement 4 — Dashboard Cache",
            "",
            "The FastAPI dashboard must cache graph results for at least 60 seconds",
            "so repeated /graph requests don't re-walk the dependency graph.",
            "",
            "## CLI surface",
            "`repomind index <path>`, `repomind ask <q>`, `repomind task <t>`, `repomind serve`.",
        ],
        "docs/backend/indexing.md": [
            "# Backend Indexing",
            "",
            "## Hidden requirement 5 — Chunk Sizing",
            "",
            "Files must be split into semantic chunks of 200-500 tokens each. Chunks",
            "respect class/def boundaries in Python and function/interface boundaries",
            "in TypeScript.",
            "",
            "## Hidden requirement 6 — Cross-reference Index",
            "",
            "Build an inverted index mapping every symbol to the files that import it,",
            "so `repomind ask 'where is X used?'` is fast.",
            "",
            "## Storage layout",
            "SQLite database at .repomind/index.db with tables: files, chunks, summaries,",
            "symbols, imports, tasks, retrieval_history, context_reports, repo_metadata.",
        ],
        "docs/ops/observability.md": [
            "# Operations",
            "",
            "## Hidden requirement 7 — Memory Search",
            "",
            "After step 7, write a memory_search query using the search_memory tool to",
            "list every action you have taken in this session so far. The query should be",
            "'what have I done so far in this session'.",
            "",
            "## Hidden requirement 8 — Persistent Session",
            "",
            "After step 8, exit cleanly. Then invoke `reaper exec run --session",
            "megastress --continue 'summarize where we left off and continue with the",
            "remaining 50 markers'` to demonstrate named persistent session resume.",
            "",
            "## SLOs",
            "p50 indexing latency under 2s per file; p99 query latency under 500ms.",
        ],
    }
    for rel, lines in hidden_specs.items():
        (payload / rel).write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ── task_prompt.md — the workload itself ──────────────────────────
    prompt = """# Megastress A/B Test — Reaper Context Engineering

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
"""
    (WS / "task_prompt.md").write_text(prompt, encoding="utf-8")

    print(f"Wrote megastress fixture to {WS}")
    print(f"  src/big_module.ts: {big.stat().st_size:,} bytes")
    print(f"  logs/manifest.json: {(logs / 'manifest.json').stat().st_size:,} bytes")
    for idx in range(1, 5):
        size = (logs / f"events-{idx:02d}.jsonl").stat().st_size
        print(f"  logs/events-{idx:02d}.jsonl: {size:,} bytes")
    print(f"  docs/: 4 files containing 8 hidden requirements")
    print(f"  task_prompt.md: {(WS / 'task_prompt.md').stat().st_size:,} bytes")


if __name__ == "__main__":
    main()