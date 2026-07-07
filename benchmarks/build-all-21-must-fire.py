#!/usr/bin/env python3
"""
Build the "all-21-must-fire" stress fixture (v2: bigger bash outputs
that always trigger head+tail).

Strategy:
  - Each gen_N.sh produces ~12K chars of stdout (just above the 8K
    head+tail threshold so they trigger the engine's bash head+tail
    path AND the wiring's onAfterToolResult hook).
  - The model must read them via the raw stdout (we explicitly tell
    it NOT to redirect).
"""

import random
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/all-21-must-fire')
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(parents=True, exist_ok=True)

random.seed(42)

# 5000-line file: file_view cache stress
big_file_lines = []
needles = []
for line_num in range(1, 5001):
    if line_num in (123, 456, 789, 1010, 1500, 2300, 2800, 3500, 4200, 4800):
        needle = f'NEEDLE_LINE_{line_num:04d}_VALUE_{random.randint(10000, 99999):05d}'
        big_file_lines.append(f'  // {needle}')
        needles.append(needle)
    else:
        big_file_lines.append(f'line {line_num}: padding data: {"x" * random.randint(20, 80)}')

(PAYLOAD / 'big_target.ts').write_text('\n'.join(big_file_lines) + '\n')
(PAYLOAD / 'needles.txt').write_text('\n'.join(needles) + '\n')

# 5 generators, each produces ~12K stdout (above 8K stress threshold).
for n in range(1, 6):
    secret_marker = f'SECRET_{n}_MARKER_{random.randint(1000, 9999)}_FOUND'
    secret_line_idx = random.randint(50, 700)
    lines = [f'#!/bin/bash', f'# gen_{n}: produces ~12K chars of stdout']
    lines.append(f'echo "=== gen_{n} BEGIN ==="')
    for j in range(800):
        if j == secret_line_idx:
            lines.append(f'  record {j:04d} status=ok msg={secret_marker} latency={random.randint(1,500)}')
        else:
            lines.append(f'  record {j:04d} status=ok msg=running latency={random.randint(1,500)}')
    lines.append(f'echo "=== gen_{n} END ==="')
    script = '\n'.join(lines) + '\n'
    (PAYLOAD / f'gen_{n}.sh').write_text(script)
    (PAYLOAD / f'gen_{n}.sh').chmod(0o755)

# 100K output for PTL recovery stress (won't fit context, triggers 400)
ptl_lines = ['#!/bin/bash', '# ptl_gen: 100K chars']
ptl_lines.append('python3 -c "import sys; sys.stdout.write(\"x\" * 100000)"')
(PAYLOAD / 'ptl_gen.sh').write_text('\n'.join(ptl_lines) + '\n')
(PAYLOAD / 'ptl_gen.sh').chmod(0o755)

# Normal script
(PAYLOAD / 'normal.sh').write_text('#!/bin/bash\necho "normal output"\n')
(PAYLOAD / 'normal.sh').chmod(0o755)

# Small file for mtime stub
(PAYLOAD / 'small_target.txt').write_text('LINE_A\nLINE_B\nLINE_C\nLINE_D\nLINE_E\n')

# Task prompt — explicitly force bash to run raw (no redirects)
prompt = """# All-21-Must-Fire Stress Test

You are inside `payload/`. This fixture is designed to force EVERY one of
Reaper's 21 context-engineering layers to fire at least once.

## Mandatory steps (in order — do not skip)

### Step 1: file_view cache (layers #1, #4)
Use `file_view` to read `big_target.ts` from line 1 to line 100. Then re-read
it 5 more times. (The cache should hit after the first read.)

### Step 2: Find 10 NEEDLEs
Read `needles.txt` to get the expected needle values. Then use `grep_search`
on `big_target.ts` to verify each needle is present. Write findings to
`found_needles.txt`.

### Step 3: Run 5 generators (force bash head+tail layer #2)
CRITICAL: invoke each `gen_1.sh` through `gen_5.sh` via exactly:
    bash gen_1.sh
    bash gen_2.sh
    bash gen_3.sh
    bash gen_4.sh
    bash gen_5.sh
You MUST NOT use shell redirection (no >, no |, no tee). Each command's
raw stdout is captured as the tool result. The expected line count is
around 800 records. Find each SECRET_N_MARKER. Write findings to
`gen_secrets.txt`.

### Step 4: Edit small_target.txt (layer #3)
Change `LINE_C` to `LINE_C_MODIFIED`. Then `file_view` to verify.

### Step 5: Run ptl_gen.sh (layer #8 PTL recovery)
Run `bash ptl_gen.sh` (it produces 100K chars). The runtime will use
PTL recovery to keep going.

### Step 6: Run normal.sh (verify normal output still works)
Run `bash normal.sh`.

### Step 7: Final report
Write `final_report.md` summarizing:
- 10 NEEDLEs found
- 5 SECRET_N_MARKERs found
- Edit verification
- End with `###TASK_COMPLETED###`
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

total_files = len(list(PAYLOAD.rglob('*')))
total_bytes = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built all-21-must-fire fixture v2:')
print(f'  files: {total_files}')
print(f'  size:  {total_bytes:,} bytes')
print(f'  big_target.ts: 5000 lines (file_view cache stress)')
print(f'  gen_1..5.sh: each produces ~12K stdout (bash head+tail)')
print(f'  ptl_gen.sh: 100K stdout (PTL recovery stress)')
print(f'  small_target.txt: 5 lines (mtime stub stress)')