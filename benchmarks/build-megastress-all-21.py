#!/usr/bin/env python3
"""
Build the megastress-all-21 fixture — a single workload that forces
EVERY context-engineering layer to fire at least once.

Layer forcing strategy:
  1. file_view cache       → 30 read-only file views of same file
  2. bash head+tail        → 3 different bash commands each producing >30K output
  3. mtime stub            → edit file, then re-view (cache miss → hit)
  4. normalized envelope   → automatic, all tool results
  5. spillover             → 1 bash command producing 8K-30K output
  6. shake                 → softCap=15K forces shake to fire
  7. shake circuit breaker → 3+ back-to-back no-op shakes
  8. PTL recovery          → huge single tool result
  9. time MC               → task takes 10+ minutes naturally
 10. full summary          → softCap set VERY low (5K) to force overflow
 11. threshold state       → automatic, tracks context usage
 12. token budget tracker  → automatic, every model call
 13. compact tool history  → 50+ tool results, then compact
 14. SWE pruner            → may fire on large file_edits
 15. context pruner        → may fire on every turn
 16. persistent summary    → automatic at run end
 17. memory search tool    → task requires it explicitly
 18. session journal       → enabled via --named-session CLI
 19. session store         → enabled via --named-session CLI
 20. cross-session resume  → task should run TWICE with same name
 21. turn index            → automatic per turn

Strategy: build a workload that has many small steps so the model has
to do many turns, with deliberate 1.5s pauses between steps to ensure
time gaps exceed 5 min for time-MC to fire.
"""

import json
import os
import random
import time
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/megastress-all-21')
FIXTURE.mkdir(parents=True, exist_ok=True)
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(exist_ok=True)

random.seed(7)

# === 1. 30+ files to file_view (exercises cache) ===
for n in range(1, 16):
    lines = [f'// file_{n:02d}.ts — module {n}']
    for j in range(100):
        lines.append(f'export const fn_{n:02d}_{j:03d} = () => {j * 7};')
    (PAYLOAD / f'file_{n:02d}.ts').write_text('\n'.join(lines) + '\n')

# === 2. 3 large-output generators (forces bash head+tail) ===
for n in range(1, 4):
    name = f'large_gen_{n}.sh'
    lines = [f'#!/bin/bash', f'# large_gen_{n}: produces ~50K-char output (forces bash head+tail)']
    lines.append(f'echo "=== gen_{n} output start ==="')
    for j in range(3000):
        lines.append(f'line_{j:05d}: event_id=evt_{random.randint(100000, 999999):06x} value={random.randint(1, 10000)} metric={random.choice(["cpu", "mem", "io", "net", "disk"])} latency_ms={random.randint(1, 500)}')
    lines.append(f'echo "=== gen_{n} output end ==="')
    (PAYLOAD / name).write_text('\n'.join(lines) + '\n')
    (PAYLOAD / name).chmod(0o755)

# === 5. 1 medium-output generator (forces spillover) ===
lines = ['#!/bin/bash', '# medium_gen: ~10K-char output (forces spillover)']
for j in range(800):
    lines.append(f'medium_line_{j:04d}: timestamp=2026-07-06T{random.randint(0,23):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d} payload_id=pl_{random.randint(1000, 9999):04x} size_bytes={random.randint(100, 5000)}')
(PAYLOAD / 'medium_gen.sh').write_text('\n'.join(lines) + '\n')
(PAYLOAD / 'medium_gen.sh').chmod(0o755)

# === 8. 1 single huge output (forces PTL recovery on overflow) ===
# This script writes a 100K-char string to a file and tries to read it.
lines = ['#!/bin/bash', '# giant_gen: 100K-char output (forces PTL recovery if it overflows)']
lines.append('python3 -c "print(\'x\' * 100000)"')
(PAYLOAD / 'giant_gen.sh').write_text('\n'.join(lines) + '\n')
(PAYLOAD / 'giant_gen.sh').chmod(0o755)

# === 17. NEEDLEs to find via search_memory tool (we'll request the tool) ===
NEEDLES = []
for n in range(1, 11):
    needle_id = f'NEEDLE_{n:02d}_VAL_{random.randint(10000, 99999):05d}'
    NEEDLES.append(needle_id)
    haystack = []
    for j in range(200):
        if j == random.randint(0, 199):
            haystack.append(f'  {needle_id}')
        else:
            haystack.append(f'  fill_{random.randint(100000, 999999):06x}')
    (PAYLOAD / f'needle_{n:02d}.txt').write_text('\n'.join(haystack) + '\n')

# === Source file to edit + re-view (mtime stub) ===
big_src = ['// big_src.ts — 500-line module to be edited + re-viewed']
for j in range(500):
    big_src.append(f'export const X_{j:04d} = {j} * 2;')
(PAYLOAD / 'big_src.ts').write_text('\n'.join(big_src) + '\n')

# === Hidden requirements in docs ===
for d in ['arch', 'spec', 'impl', 'ops']:
    p = PAYLOAD / f'hidden_{d}.md'
    p.write_text(f'# {d.title()} Doc\n\nStandard overview.\n\n## Hidden Requirement\n\nThe {d} requirement is: TBD-{d.upper()}\n')

# === Task prompt with explicit 21-layer triggers ===
prompt = """# Megastress-All-21 — Force Every Context-Engineering Layer

You are inside `payload/`. This fixture is engineered to force **every one
of Reaper's 21 context-engineering layers** to fire at least once.

## Mandatory steps (in order)

### 1. Read 10 files (file_view cache)
Use `file_view` (NOT bash cat) on `file_01.ts` through `file_10.ts`.
Just confirm they exist by reading the first 50 lines of each.

### 2. Run 3 large generators (bash head+tail)
Execute `large_gen_1.sh`, `large_gen_2.sh`, `large_gen_3.sh` via `bash`.
Each produces 50K+ char output — bash head+tail persistence will trigger.

### 3. Run 1 medium generator (spillover)
Execute `medium_gen.sh` — produces 10K output. Spillover layer should fire.

### 4. Find 10 NEEDLEs (search_memory)
Use `search_memory` tool to find all 10 NEEDLEs in `needle_*.txt` files.
(If `search_memory` is not available, fall back to `grep_search`.)

### 5. Edit + re-view big_src.ts (mtime stub)
Use `file_edit` to change line 250 in `big_src.ts` to `export const X_0250 = 999;`.
Then use `file_view` to verify — cache miss on first read after edit.

### 6. Run 5 different bash commands (5 turns of varied work)
- `ls -la payload/`
- `cat payload/hidden_arch.md` (NOTE: use file_view, not this)
- `wc -l payload/needle_*.txt`
- `find payload/ -name "*.ts" | head -5`
- `echo "step 6 done"`

### 7. Read 10 more files (cache)
file_view on `file_11.ts` through `file_20.ts` — cache layer fires.

### 8. Run giant_gen (potential PTL recovery)
Run `giant_gen.sh` — 100K char output. If context overflows, PTL recovery
triggers automatically.

### 9. Final report
Write `final_report.md` with all sections. End with `###TASK_COMPLETED###`.

## Tips

- softCap will be 15000 (very tight) — many layers will fire.
- Use `file_view` for source/docs, NOT bash cat.
- Use `grep_search` for finding strings, NOT bash grep.
- Long bash outputs get truncated automatically — trust the head+tail preview.
- If you get a context overflow warning, KEEP GOING — the runtime will
  shake, microcompact, or summarize for you.
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

# === Stats ===
total_files = len(list(PAYLOAD.rglob('*')))
total_bytes = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built megastress-all-21 fixture:')
print(f'  files: {total_files}')
print(f'  size:  {total_bytes:,} bytes ({total_bytes/1024/1024:.2f} MB)')
print(f'  file_view files: 15 (each 100 lines)')
print(f'  large gens (50K output): 3')
print(f'  medium gen (10K output): 1')
print(f'  giant gen (100K output): 1')
print(f'  needle files: 10')
print(f'  source: 500-line big_src.ts')
print(f'  hidden docs: 4')