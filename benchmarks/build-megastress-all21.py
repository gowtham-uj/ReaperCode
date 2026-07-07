#!/usr/bin/env python3
"""Big fixture that forces ALL 21 context-engineering layers to fire.

Layers we target:
  #1  file_view cache           — repeated reads of the same file
  #2  bash head+tail            — multiple big stdout commands
  #3  mtime stub                 — edit file, re-view (mtime changes)
  #4  normalized envelope        — automatic
  #5  spillover                  — bash output → /reaper/artifacts
  #6  shake w/ circuit breaker   — tokens > threshold
  #7  shake iterated (PTL loop)  — 4 forced back-to-back
  #9  time microcompact          — 35s gap between calls
  #10 full summarization         — token > softCap - 16K
  #12 token budget tracker       — automatic
  #13 compact tool history       — automatic
"""

import random
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/megastress-all21')
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(parents=True, exist_ok=True)
random.seed(11)

# 8 generators at ~10K each → ~80K chars total → forces full-summary.
for i in range(1, 9):
    name = f'gen_{i}.sh'
    secret = f'SECRET_{i}_MARKER_{random.randint(10000, 99999)}_FOUND'
    lines = [f'#!/bin/bash', f'# {name}: ~10K stdout + 35s sleep', f'sleep 35']
    secret_idx = random.randint(50, 200)
    for j in range(200):
        if j == secret_idx:
            lines.append(f'echo "record {i}.{j:03d} status=ok msg={secret} latency={random.randint(1,500)}"')
        else:
            lines.append(f'echo "record {i}.{j:03d} status=ok msg=running latency={random.randint(1,500)}"')
    lines.append(f'echo "{secret} appears at line {secret_idx + 5}"')
    (PAYLOAD / name).write_text('\n'.join(lines) + '\n')
    (PAYLOAD / name).chmod(0o755)

# Small source tree
repo = PAYLOAD / 'src'
repo.mkdir(exist_ok=True)
(repo / 'index.ts').write_text('// index.ts\nimport { helper } from "./helper.js";\nexport function main() { return helper("init"); }\n')
(repo / 'helper.js').write_text('// helper.js\nexport function helper(name) { return `greeting for ${name}`; }\n')
(repo / 'package.json').write_text('{"name":"megastress","version":"1.0.0"}\n')

# Task prompt — PROHIBITED redirects
prompt = """# megastress-all21 (force all 21 context-engineering layers)

You are in `payload/`. **PROHIBITED for this entire run**: any use of
`>`, `| head`, `| tail`, `| wc`, `| grep`, or any redirect that shrinks
bash stdout below 1K chars. Each call must let the FULL stdout flow
back to the runtime. Hard test constraint.

## Steps (do not skip, do not reorder)

1. Read `src/index.ts` and `src/helper.js` twice each (file_view cache).

2. Read `src/index.ts` a third time to confirm cache hit.

3. Run `bash gen_1.sh` through `bash gen_8.sh` ONCE each, in numerical
order, no redirects, no pipes. Each sleeps 35s. After all 8 complete,
compile a list of SECRET_n_MARKER values.

4. Write `final.md` with the 8 SECRET_n_MARKER values. End with
`###TASK_COMPLETED###`.

This fixture is designed to force:
- bash head+tail (each gen_*.sh outputs > 8K chars)
- time-microcompact (35s gaps between gen_*.sh commands)
- shake (cumulative tool results)
- full summarization (final context > 8000 - 16K threshold)
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

total = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built megastress-all21: {total:,} bytes, {len(list(PAYLOAD.rglob("*")))} files')
print('  Each gen_*.sh: 8K stdout + 35s sleep')