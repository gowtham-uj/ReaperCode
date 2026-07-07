# All-21-Must-Fire-v3 Stress Test (revised for time-MC)

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
