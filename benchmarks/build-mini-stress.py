#!/usr/bin/env python3
"""Build a small but layered fixture that triggers every compactor layer
on MiniMax-M3 within ~30 tool calls."""

import random
from pathlib import Path

FIXTURE = Path('/workspace/reapercode-main/benchmarks/mini-stress')
PAYLOAD = FIXTURE / 'payload'
PAYLOAD.mkdir(parents=True, exist_ok=True)
random.seed(2)

# 4 small generators that produce ~12K stdout each (triggers bash head+tail
# and contributes to >8K cap for full-summary).
for i in range(1, 5):
    name = f'gen_{i}.sh'
    secret = f'SECRET_{i}_MARKER_{random.randint(10000, 99999)}'
    lines = [f'#!/bin/bash', f'# {name}: 12K stdout', f'sleep 0.3']
    secret_idx = random.randint(50, 350)
    for j in range(500):
        if j == secret_idx:
            lines.append(f'  record {i}.{j:03d} status=ok msg={secret} latency={random.randint(1,500)}')
        else:
            lines.append(f'  record {i}.{j:03d} status=ok msg=running latency={random.randint(1,500)}')
    lines.append(f'echo "{secret} appears at line {secret_idx + 4}"')
    (PAYLOAD / name).write_text('\n'.join(lines) + '\n')
    (PAYLOAD / name).chmod(0o755)

# 1 longer sleep to fire time-microcompact (>=30s gap).
(PAYLOAD / 'long_sleep.sh').write_text('#!/bin/bash\nsleep 32\necho "woke up"\n')
(PAYLOAD / 'long_sleep.sh').chmod(0o755)

# 1 huge tool result that bash head+tail should fire on.
(PAYLOAD / 'big.sh').write_text('#!/bin/bash\nsleep 1\nfor i in $(seq 1 6000); do echo "row $i: padding data for context bloat test"; done\n')
(PAYLOAD / 'big.sh').chmod(0o755)

# Repo source so file_view cache fires.
repo = PAYLOAD / 'src'
repo.mkdir(exist_ok=True)
(repo / 'index.ts').write_text('// index.ts\nimport { helper } from "./helper.js";\nexport function main() { return helper("init"); }\n')
(repo / 'helper.js').write_text('// helper.js\nexport function helper(name) { return `greeting for ${name}`; }\n')

prompt = """# mini-stress (forced layer firing)

You are in `payload/`. **PROHIBITED** for the entire run: any use of `>`,
`| head`, `| tail`, `| wc`, `| grep`, or any other redirect/pipe on tool
output that would shrink bash stdout below 1K chars. Each call must let
the FULL bash stdout flow back to the runtime. This is a hard test
constraint.

## Steps (do not skip, do not reorder)

### 1. Read `src/index.ts` and `src/helper.js` twice each (file_view cache).

### 2. Run `bash big.sh` ONCE. The output is ~100K chars. DON'T redirect.

### 3. Run `bash long_sleep.sh` ONCE. It sleeps 32s — that's the time-microcompact gap.

### 4. Run `bash gen_1.sh`, `bash gen_2.sh`, `bash gen_3.sh`,
`bash gen_4.sh` — each ONCE, no redirects. Each returns ~12K chars.
The SECRET_n_MARKER is somewhere in each output; you can use grep on
the persisted_output_path if the runtime shows it was truncated.

### 5. Write `final.md` with:
- The 4 SECRET_N_MARKER values you found
- Total tool calls made
End the file with `###TASK_COMPLETED###`.
"""
(FIXTURE / 'task_prompt.md').write_text(prompt)

total = sum(f.stat().st_size for f in PAYLOAD.rglob('*') if f.is_file())
print(f'Built mini-stress: {total:,} bytes in {PAYLOAD}')
print(f'files: {len(list(PAYLOAD.rglob("*")))}')