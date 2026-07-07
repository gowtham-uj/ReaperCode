#!/usr/bin/env python3
"""
Build the MEGA-STRESS-XL fixture — a workload designed to actually
exercise every context-engineering layer:

- bash head+tail: 5000+ line outputs (>>30K chars)
- file_view cache: same file viewed many times
- mtime-stub:    same file edited + viewed many times
- shake:         softCap=20K forces shake every few turns
- time-MC:       run takes 10+ minutes, time gap triggers MC
- full-summary:  massive tool results force summarization
- spillover:     giant JSON outputs >8KB

Structure:
- 5 huge bash-output generators (run them to get 5 different >>30K outputs)
- 50 file_view tasks (same files repeatedly to exercise cache)
- 30 grep_search tasks (find hidden needles in haystacks)
- 20 file_edit tasks (each requires reading the file first)
- A final verification (write report)
"""

import json
import os
import random
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/megastress-xl')
FIXTURE.mkdir(parents=True, exist_ok=True)
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(exist_ok=True)

random.seed(42)

# === Generate giant bash-output generators (5 different ones) ===
# Each script, when run, outputs 5,000+ lines (way over 30K chars).
# The model has to read these scripts, run them, and verify the output.
SCRIPTS = []

for i in range(1, 6):
    name = f'gen_output_{i}.sh'
    path = PAYLOAD / name
    lines = ['#!/bin/bash', f'# gen_output_{i}: produces a giant log line stream', 'echo "=== gen_output_' + str(i) + ' ==="']
    for j in range(5000):
        lvl = random.choice(['DEBUG', 'INFO', 'WARN', 'ERROR'])
        ts = f'2026-07-06T{random.randint(0,23):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}'
        worker = f'worker-{random.randint(1, 50):03d}'
        msg = random.choice([
            'connection_pool_acquire', 'cache_miss', 'rate_limit_check',
            'request_dispatched', 'response_streamed', 'metric_emitted',
            'token_usage_logged', 'circuit_breaker_check', 'retry_attempt',
            'timeout_retry', 'circuit_breaker_open', 'graceful_shutdown',
            'config_reload', 'queue_overflow', 'slow_query_detected',
        ])
        req_id = f'req-{random.randint(100000, 999999):06x}'
        lines.append(f'[{ts}] [{lvl}] {worker} {msg} req_id={req_id} latency_ms={random.randint(1, 2000)} size={random.randint(100, 50000)}')
    path.write_text('\n'.join(lines) + '\n')
    path.chmod(0o755)
    SCRIPTS.append(name)

# === Hidden "needles" in haystacks ===
# The task is to find all 12 needles (each appears in a different file).
# The model has to use grep_search (not bash) to find them.
for n in range(1, 13):
    needle_id = f'NEEDLE_{n:02d}_SIGNATURE_{random.randint(10000, 99999):05d}'
    haystack_lines = []
    for j in range(800):
        if j == random.randint(0, 799):
            haystack_lines.append(f'  {needle_id}')
        else:
            haystack_lines.append(f'  random_data_{random.randint(100000, 999999):06x}_{random.choice(["alpha","beta","gamma","delta","epsilon"])}')
    (PAYLOAD / f'haystack_{n:02d}.txt').write_text('\n'.join(haystack_lines) + '\n')

# === Big source file that requires many small edits ===
big_src = ['// SOURCE_FILE: this is a 2000-line module that needs targeted edits']
for j in range(2000):
    big_src.append(f'export const VALUE_{j:04d} = {j} * {random.randint(2, 9)};')
(PAYLOAD / 'source_module.ts').write_text('\n'.join(big_src) + '\n')

# === Hidden requirements in markdown docs ===
for d in ['architecture', 'product', 'backend', 'ops']:
    p = PAYLOAD / f'docs_{d}.md'
    p.parent.mkdir(exist_ok=True)
    content = [f'# {d.title()} Doc\n', '## Overview\n', 'Standard overview text here.\n']
    content.append(f'\n## Hidden Requirement ({d})\n')
    content.append(f'NEEDLE in this doc: NEEDLE_{d.upper()[:3].ljust(8, "X")}_SIGNATURE_99999\n')
    content.append('\n## Implementation notes\nMore text here.\n')
    p.write_text(''.join(content))

# === Task prompt ===
prompt = """# MEGA-STRESS-XL — Exercise Every Reaper Context-Engineering Layer

You are inside `payload/`. This fixture is designed to force **every**
context-engineering layer in Reaper to fire:

  - bash head+tail persistence (5 scripts each produce 5000-line output)
  - file_view cache (you'll view the same files many times)
  - mtime-stub (you'll edit then re-view)
  - shake (softCap is set very low: 20K)
  - time-microcompact (this task takes 10+ minutes)
  - full-summary (massive tool outputs)
  - spillover (some outputs are >>8KB)

## Tasks

### 1. Run all 5 generators
Execute each `gen_output_N.sh` via `bash` and **capture the output**.
Because each is >>30K chars, you must use `file_view` or read in
chunks — do NOT try to cat the entire output to your context.

### 2. Find all 12 NEEDLEs
Use `grep_search` (NOT bash cat) to find every `NEEDLE_NN_SIGNATURE_*`
string across `haystack_*.txt` files. Write them to `found_needles.txt`
as `needle_id: haystack_file` pairs, one per line.

### 3. Hidden requirements
Read each `docs_*.md` file via `file_view`. Extract the hidden
requirement and write them to `hidden_requirements.txt`.

### 4. Edit the source module
In `source_module.ts`, change line 1000 to `export const VALUE_1000 = 999;`.
Then verify by re-reading the file.

### 5. Write a final report
Create `final_report.md` summarizing:
- Total lines from each generator
- Total NEEDLEs found (should be 12)
- Hidden requirements extracted
- The edit you made

### 6. Honest completion
End with `###TASK_COMPLETED###` and a 1-paragraph summary.

## Tips

- Use `file_view` for source/docs, NOT `bash cat`.
- Use `grep_search` for finding strings, NOT `bash grep`.
- If a tool result is huge, trust the head+tail preview and reference
  the spillover artifact path.
- If you get a context overflow warning, KEEP GOING — the runtime will
  shake/microcompact/summarize for you.
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

# === Stats ===
total_files = len(list(PAYLOAD.rglob('*')))
total_bytes = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built megastress-xl fixture:')
print(f'  files: {total_files}')
print(f'  size:  {total_bytes:,} bytes ({total_bytes/1024/1024:.1f} MB)')
print(f'  scripts (each >30K output): 5')
print(f'  haystacks (each ~50KB): 12')
print(f'  source_module.ts: 2000 lines')
print(f'  docs: 4')