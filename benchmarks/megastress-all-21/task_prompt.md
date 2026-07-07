# Megastress-All-21 — Force Every Context-Engineering Layer

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
