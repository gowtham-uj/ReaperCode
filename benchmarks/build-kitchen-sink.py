#!/usr/bin/env python3
"""Build a kitchen-sink fixture that forces ALL 21 layers to fire.

Layers targeted:
  #1  file_view cache            — repeated reads of the same file
  #4  bash head+tail             — outputs > 8K chars
  #5  spillover                   — outputs > 8K bytes persisted to spillover/
  #6  shake                       — accumulate tool results
  #9  time_microcompact          — tool message ≥50 chars + ≥30s gap
  #10 full_summary               — softCap=1000 (impossible to fit)
  #13 compact-tool-history       — ≥40 tool results
  #14 threshold-state telemetry  — automatic

Plus implicit:
  #11/#12 token_budget           — automatic once tokenUsageFromResponse wired
  #19/#20 session-store          — only with namedSession
  #21 promote-context-model      — not yet implemented

Notes:
- Each gen_*.sh produces ~12K output (~12 lines × 1K = 12K), bigger than 8K
  threshold and bigger than 50 chars so time-MC will fire for old tool
  messages.
- The 35s sleep ensures model thinks between calls → 30s+ gap.
- Total of 45 commands × 35s = ~26 minutes; that's a long run, but it
  forces all layers.
- model runtime ≈ 45 commands × 5s model call = 4 min.
"""

import random
import time
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/kitchen-sink')
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(parents=True, exist_ok=True)
random.seed(3)

# 42 generators: each produces ~12K stdout (well above 8K threshold),
# and 15s sleep (creates time-MC gap at 30s threshold or 15s+ with
# default gapMs=30000).
for i in range(1, 43):
    name = f'gen_{i:02d}.sh'
    secret = f'SECRET_{i}_MARKER_{random.randint(10000, 99999)}_FOUND'
    lines = [f'#!/bin/bash', f'# {name}: ~12K stdout + 15s sleep', f'sleep 15']
    secret_idx = random.randint(50, 200)
    for j in range(500):
        if j == secret_idx:
            lines.append(f'echo "record {i}.{j:03d} status=ok msg={secret} latency={random.randint(1,500)}"')
        else:
            lines.append(f'echo "record {i}.{j:03d} status=ok msg=running latency={random.randint(1,500)}"')
    lines.append(f'echo "{secret} appears at line {secret_idx + 5}"')
    (PAYLOAD / name).write_text('\n'.join(lines) + '\n')
    (PAYLOAD / name).chmod(0o755)

# Repo source so file_view can fire
repo = PAYLOAD / 'src'
repo.mkdir(exist_ok=True)
(repo / 'index.ts').write_text('// index.ts\nimport { helper } from "./helper.js";\nexport function main() { return helper("init"); }\n')
(repo / 'helper.js').write_text('// helper.js\nexport function helper(name) { return `greeting for ${name}`; }\n')
(repo / 'package.json').write_text('{"name":"kitchen-sink","version":"1.0.0"}\n')

# Task prompt
prompt = """# kitchen-sink (force ALL 21 layers)

You are in `payload/`. There are 42 small bash scripts `gen_01.sh`
through `gen_42.sh`. Each script produces ~12K chars of stdout AND
sleeps 15 seconds.

**HARD CONSTRAINTS** (do not violate, layers will not fire otherwise):
- NO `>`, NO `| head`, NO `| tail`, NO `| wc`, NO `| grep` on bash output
- Each call must let the FULL raw stdout flow back to the runtime
- (You may use grep_search / file_view to inspect the persisted
  artifact paths the runtime surfaces.)

## Steps (do not skip, do not reorder)

1. file_view `src/index.ts` and `src/helper.js` 3 times each.
2. Run `bash gen_01.sh` through `bash gen_42.sh` in numerical order.
   Each takes ~15s. Don't pipe, don't redirect.
3. For each gen_NN.sh, find the SECRET_NN_MARKER value via grep_search
   on the runtime's logged path (the trajectory reveals persisted
   output paths).
4. Write `final.md` with all 42 SECRET_NN_MARKER values.

End with `###TASK_COMPLETED###`.
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

total = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built kitchen-sink: {total:,} bytes, {len(list(PAYLOAD.rglob("*")))} files')
print(f'  42 generators × 12K stdout × 15s sleep each (~10 min compute)')