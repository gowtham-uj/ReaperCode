# Reaper Giant Stress — Exercise Every Context-Management Layer

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
