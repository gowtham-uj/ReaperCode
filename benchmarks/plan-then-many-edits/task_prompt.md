# Reaper Stress Test — Long Plan + 100 Edits

You are testing that Reaper preserves the relationship between a long
planning assistant turn and the many small edits it spawns, even after
shake prunes intermediate tool results.

Steps:

1. Read `payload/target.c` with `file_view`.
2. In your NEXT assistant turn (no tool calls), produce a written plan
   that lists ALL 100 edits in order: for each marker
   `/* EDIT_POINT_NNN */`, state the line number and the exact
   replacement string you will insert. The plan must be ≥ 4,000 chars
   of prose and lists.
3. Then execute the plan by calling `file_edit` 100 times, once per
   marker. Each call replaces `/* EDIT_POINT_NNN */` with
   `/* EDIT_POINT_NNN :: fixed */`.
4. After all 100 edits, run `bash`:
   `grep -c "EDIT_POINT_.* :: fixed" payload/target.c`
   and verify the count is exactly 100.
5. Write `out/edit-report.json`:
   ```json
   {
     "edits_planned": 100,
     "edits_attempted": 100,
     "edits_succeeded": 100,
     "duplicate_edits": [],
     "skipped_edits": [],
     "planning_message_intact": true
   }
   ```
6. Final message: confirm the plan survived any compaction.