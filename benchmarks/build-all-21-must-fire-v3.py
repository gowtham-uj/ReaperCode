#!/usr/bin/env python3
"""Build the all-21-must-fire-v3 stress fixture (v3 — large labs + sleeps)."""
import random
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/all-21-must-fire-v3')
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(parents=True, exist_ok=True)
random.seed(42)

# Small src tree
repo = PAYLOAD / 'src'
repo.mkdir(parents=True, exist_ok=True)
(repo / 'index.ts').write_text(
    '// index.ts\n'
    'import { helper } from "./helper.js";\n'
    '// NEEDLE_01_VALUE=42\n'
    'export function main() { return helper("init"); }\n'
)
(repo / 'helper.js').write_text(
    '// helper.js\n'
    '// NEEDLE_02_VALUE=hello\n'
    'export function helper(name) { return `greeting for ${name}`; }\n'
)
(repo / 'package.json').write_text('{"name": "stress-app", "version": "1.0.0"}\n')

# 4 large scripts (5K stdout each) that sleep 35s, so older ones age past
# the 30s time-MC gap while the most recent (sleeping now) doesn't.
for i in range(1, 5):
    name = f'long_lab_{i}.sh'
    secret = f'LAB_{i}_VALUE_{random.randint(10000, 99999)}'
    lines = [f'#!/bin/bash', f'# {name}: 5K stdout + 35s sleep', f'sleep 35']
    secret_line_idx = random.randint(50, 350)
    for j in range(500):
        if j == secret_line_idx:
            lines.append(f'  record {i}.{j:03d} status=ok msg={secret} latency={random.randint(1,500)}')
        else:
            lines.append(f'  record {i}.{j:03d} status=ok msg=running latency={random.randint(1,500)}')
    lines.append(f'echo "{secret} appears at line {secret_line_idx + 6}"')
    (PAYLOAD / name).write_text('\n'.join(lines) + '\n')
    (PAYLOAD / name).chmod(0o755)

# 1 huge tool: 60K stdout (forces bash head+tail AND PTL recovery).
huge_lines = ['#!/bin/bash', '# huge_gen.sh: 60K stdout', 'sleep 2']
for j in range(4000):
    huge_lines.append(f'  record {j:04d} status=ok msg=running latency={random.randint(1,500)}')
huge_lines.append('echo "==== END OF huge_gen.sh OUTPUT ===="')
(PAYLOAD / 'huge_gen.sh').write_text('\n'.join(huge_lines) + '\n')
(PAYLOAD / 'huge_gen.sh').chmod(0o755)

# Task prompt
prompt = """# All-21-Must-Fire-v3 Stress Test (revised for time-MC)

You are inside `payload/`. There are scripts that produce deterministic output.

## STRICT Mandatory Steps (do not deviate)

### Step 1: Inspect project (file_view cache layer)
- file_view `src/index.ts` lines 1-20
- file_view `src/helper.js` lines 1-20
- file_view `package.json` lines 1-5
- Re-read these 5 times (file_view cache MUST hit)
- Find NEEDLE strings; write them to `needles_found.txt`

### Step 2: Run `huge_gen.sh` ONCE (bash_head_tail + PTL recovery)
Run exactly: `bash huge_gen.sh` — no redirects, no pipes.

### Step 3: Run large labs A-D IN SEQUENCE (forces time_microcompact + full_summary)
Run each of these four, ONE AT A TIME, in order:
  bash long_lab_1.sh
  bash long_lab_2.sh
  bash long_lab_3.sh
  bash long_lab_4.sh

Each script produces ~5K chars of stdout AND sleeps 35s. The runtime's
time-microcompact layer is designed to clear the older 5K results once
they age past the 30s threshold. Do not run them in parallel.

DO NOT use shell redirection. The test specifically requires the raw
stdout to flow back as the tool result.

### Step 4: Final report
Write `final_report.md` summarizing steps. End with `###TASK_COMPLETED###`.

## Important
- DO NOT use `|` or `>` to redirect/pipe.
- Run scripts sequentially, not in parallel.
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

# Cleanup old small scripts from previous build
for f in PAYLOAD.glob('sleep_n_*.sh'):
    f.unlink()

total_files = len(list(PAYLOAD.rglob('*')))
total_bytes = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built all-21-must-fire v3 (revised):')
print(f'  files: {total_files}')
print(f'  size:  {total_bytes:,} bytes')
print(f'  4x long_lab_*.sh: 5K stdout + 35s sleep (time-MC + full-summary)')
print(f'  huge_gen.sh: 60K stdout (bash_head_tail + ptl_recovery)')