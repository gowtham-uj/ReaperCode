# MEGA-STRESS-XL — Exercise Every Reaper Context-Engineering Layer

You are inside `payload/`. This fixture is designed to force **every**
context-engineering layer in Reaper to fire:

  - bash head+tail persistence (5 scripts each produce 5000-line output)
  - file_view cache (you'll view the same files many times)
  - mtime-stub (you'll edit then re-view)
  - shake (softCap is set very low: 20K)
  - time-microcompact (this task takes 10+ minutes)
  - full-summary (massive tool outputs)
  - spillover (some outputs are >>8KB)

## Tasks

### 1. Run all 5 generators
Execute each `gen_output_N.sh` via `bash` and **capture the output**.
Because each is >>30K chars, you must use `file_view` or read in
chunks — do NOT try to cat the entire output to your context.

### 2. Find all 12 NEEDLEs
Use `grep_search` (NOT bash cat) to find every `NEEDLE_NN_SIGNATURE_*`
string across `haystack_*.txt` files. Write them to `found_needles.txt`
as `needle_id: haystack_file` pairs, one per line.

### 3. Hidden requirements
Read each `docs_*.md` file via `file_view`. Extract the hidden
requirement and write them to `hidden_requirements.txt`.

### 4. Edit the source module
In `source_module.ts`, change line 1000 to `export const VALUE_1000 = 999;`.
Then verify by re-reading the file.

### 5. Write a final report
Create `final_report.md` summarizing:
- Total lines from each generator
- Total NEEDLEs found (should be 12)
- Hidden requirements extracted
- The edit you made

### 6. Honest completion
End with `###TASK_COMPLETED###` and a 1-paragraph summary.

## Tips

- Use `file_view` for source/docs, NOT `bash cat`.
- Use `grep_search` for finding strings, NOT `bash grep`.
- If a tool result is huge, trust the head+tail preview and reference
  the spillover artifact path.
- If you get a context overflow warning, KEEP GOING — the runtime will
  shake/microcompact/summarize for you.
