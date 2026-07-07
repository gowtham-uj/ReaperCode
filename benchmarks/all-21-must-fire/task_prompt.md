# All-21-Must-Fire Stress Test

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
