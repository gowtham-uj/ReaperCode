#!/usr/bin/env python3
"""Build the giant-stress fixture: a single scenario that exercises
every Reaper context-management layer at once.

Layers exercised:
  Tier 1: workspace-config (softCap override), normalized envelope, shake,
          spillover, file-read cache, bounded git_diff, lazy tools, plan state.
  Tier 2: mtime-stub for re-reads, circuit breaker, PTL recovery helper,
          time-based microcompact, warning/error/blocking thresholds.
  Tier 3: full-summarization (when softCap is tight enough to trigger).
  Tier 4: bash head+tail persistence (giant bash output fixture).

Output:
  benchmarks/giant-stress/
    task_prompt.md
    payload/
      big_module.ts   ~1MB of TS source with 200 numbered markers.
                       Model must edit all 200 markers (MASSIVE shake).
      big_log.txt     ~500KB log with random-access needles.
      run_giant.sh    Bash script that produces 1.5MB stdout.
"""
import json, random, os
from pathlib import Path

random.seed(20260705)
ROOT = Path("/workspace/reapercode-main/benchmarks/giant-stress")
payload = ROOT / "payload"
payload.mkdir(parents=True, exist_ok=True)

# big_module.ts: 1.5MB of TS source with 200 numbered markers.
# 5000 lines of dense TS, ~300 chars/line → ~1.5MB
ts_lines = [
    "// giant_module.ts — synthetic source for the giant A/B stress test",
    "/*",
    " * This module is deliberately large to force Reaper's file_view tool",
    " * to return a windowed read. Each `EDIT_POINT_NNN` marker is on a",
    " * unique line, scattered through the file. The model must edit all",
    " * 200 of them. The conversation grows during the 200 edits and",
    " * triggers shake, threshold state, and (with a tight softCap)",
    " * full-summarization.",
    " */",
    "",
    "export const FRUITS: Record<string, string> = {",
]
fruits = ["apple","banana","cherry","date","elderberry","fig","grape","honeydew","kiwi","lemon","mango","nectarine","orange","papaya","quince","raspberry","strawberry","tangerine","ugli","vanilla"]
for i in range(1, 2001):
    fruit = fruits[i % 20]
    if i % 25 == 0:
        ts_lines.append(f'  // EDIT_POINT_{i // 25:03d}')  # 001..080 (every 25th of 2000 = 80 markers)
    ts_lines.append(f'  {fruit}_{i}: "{fruit}",  // entry {i:04d} of 2000 fruit registry entries')
ts_lines.append("};")
ts_lines.append("")
# Add a 5000-line helper module.
ts_lines.append("export function pick_random(): string {")
ts_lines.append("  const keys = Object.keys(FRUITS);")
ts_lines.append("  const idx = Math.floor(Math.random() * keys.length);")
ts_lines.append("  return FRUITS[keys[idx]];")
ts_lines.append("}")
ts_lines.append("")
# 200 numbered helper functions, each ~12 lines → ~2400 lines.
for i in range(1, 201):
    ts_lines.append(f"// helper function #{i:03d}")
    if i % 10 == 0:
        ts_lines.append(f"// EDIT_POINT_{i // 10 + 20:03d}")  # 21..40
    ts_lines.append(f"export function helper_{i:03d}(x: number): number {{")
    ts_lines.append(f"  // BEGIN helper_{i:03d} body — pads the file so file_view returns a 500-line window")
    ts_lines.append(f"  const a = x + {i};")
    ts_lines.append(f"  const b = x * {i};")
    ts_lines.append(f"  const c = x - {i};")
    ts_lines.append(f"  if (a > 0) {{ return (a + b) * c + {i}; }} else {{ return a - b + c - {i}; }}")
    ts_lines.append(f"  // END helper_{i:03d} body — padding line 7 of 12")
    ts_lines.append(f"  return a + b + c;")
    ts_lines.append("}")
    ts_lines.append("")
(ROOT / "payload" / "big_module.ts").write_text("\n".join(ts_lines) + "\n")
print("wrote big_module.ts:", (ROOT / "payload" / "big_module.ts").stat().st_size, "bytes")

# big_log.txt: 500KB log with random needles.
log_lines = ["=== BIG LOG v1 ==="]
for i in range(1, 8001):
    log_lines.append(f"line {i:05d} :: seq={i} value={i:08d} hash={i:08x} status={'ok' if i % 7 else 'warn'}")
(ROOT / "payload" / "big_log.txt").write_text("\n".join(log_lines) + "\n")
print("wrote big_log.txt:", (ROOT / "payload" / "big_log.txt").stat().st_size, "bytes")

# run_giant.sh: produces 1.5MB stdout deterministically.
(ROOT / "payload" / "run_giant.sh").write_text(
    "#!/usr/bin/env bash\n"
    "# Deterministic 1.5MB stdout generator for the giant A/B stress test.\n"
    "{\n"
    "  for i in $(seq 1 30000); do\n"
    "    printf 'line %05d :: seq=%d value=%064d hash=000000000000%04x status=ok\\n' \"$i\" \"$i\" \"$i\" \"$i\"\n"
    "  done\n"
    "}\n"
)
(ROOT / "payload" / "run_giant.sh").chmod(0o755)
print("wrote run_giant.sh")

# task_prompt.md
(ROOT / "task_prompt.md").write_text(
"""# Reaper Giant Stress — Exercise Every Context-Management Layer

You are stress-testing Reaper's full context-management stack. Follow these
steps IN ORDER. Do not skip any. Do not use `bash` for things that have a
specialized tool (`file_view`/`file_scroll` for files, `search_tools` for
tool discovery).

⚠️ RULES
- Use `file_view` / `file_scroll` for files; never `cat` / `head` / `tail`.
- Use `file_edit` for source changes; never write a brand-new file to replace one.
- Use `grep_search` for content search; not `bash grep`.
- The needle in the giant bash log is at line 4000: `line 04000`.
- The `EDIT_POINT_NNN` markers are in `payload/big_module.ts`. There are 200.

## Step 1 — Read the giant module (triggers shake + mtime-stub)

1. `file_view payload/big_module.ts` (full 500-line window).
2. `file_scroll` (down, 500) four more times to see the whole file.
3. After step 2, the conversation is large enough that Reaper's shake
   pass will fire. The very first `file_view` result gets replaced with
   a placeholder.
4. Confirm: do you see the marker `EDIT_POINT_001` at the top of the file?
5. Re-read `payload/big_module.ts` (5 reads total). The 4 reads after the
   first should be a cache stub.

## Step 2 — Edit all 100 markers (triggers shake under edit pressure)

There are exactly 100 `EDIT_POINT_NNN` markers in `payload/big_module.ts`:
- 001..080 in the FRUITS registry (every 25th entry)
- 081..100 in the helper function section (every 10th function)

For each `EDIT_POINT_NNN` marker, call `file_edit` exactly once with
`start_line` and `end_line` that cover the marker line, and replace it
with `// EDIT_POINT_NNN :: fixed`. Do all 100 in order.

## Step 3 — Generate the giant log (triggers bash head+tail + spillover)

Run `bash payload/run_giant.sh | head -c 1500000 > /tmp/giant.log` and then
`bash -c "cat /tmp/giant.log"`. The full output is 1.5MB; the model sees
head + tail preview. Find the line containing `line 04000` and write
its full content to `out/needle.txt`.

## Step 4 — Verify

After all 100 edits, run:
  bash -c "grep -c 'EDIT_POINT_.* :: fixed' payload/big_module.ts"
and verify the count is 100.

Write `out/report.json` with shape:
```json
{
  "edits_completed": 100,
  "duplicate_edits": 0,
  "skipped_edits": 0,
  "needle_line": "line 04000 ...",
  "shake_observed": true,
  "stub_observed": true,
  "files_re_read_count": 5
}
```

Final assistant message: confirm whether you saw `[file_view: payload/big_module.ts unchanged]`
or `[bash: completed, ...]` placeholders, and whether the planning
context survived the 200-edit batch.
"""
)
print("wrote task_prompt.md")

print("Done.")
