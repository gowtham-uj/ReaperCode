# Reaper Stress Test — Read-Then-Act Mid-Compaction

You are stress-testing Reaper's shake pruning. Follow these steps IN ORDER
and do not skip any.

⚠️ DO NOT use `bash` to read or inspect `payload/ledger.jsonl`. Use only
`file_view` and `file_scroll` for that file. `bash` is reserved for the
final verification step. The whole point of this stress test is that
`file_view` puts a large payload into context; using `bash head` /
`cat` would defeat it.

1. Use `file_view payload/ledger.jsonl` (default 500-line window) to read
   the file.
2. Scroll forward with `file_scroll` (down, 500) until you have seen the
   whole file. Each scroll call returns ~125 tokens of inline context.
3. After the third `file_scroll` call, the conversation is large enough
   that Reaper's shake pass will fire and the very first `file_view`
   result will likely be replaced with a placeholder.
4. Create `out/needle-report.json` with shape:
   ```json
   {
     "markers_found": ["NEEDLE_5K_TOKEN_OFFSET_42", ...],
     "markers_missing": [...],
     "lines_seen": 600,
     "shake_observed": true
   }
   ```
5. Finish naturally with a final message that states whether you saw any
   `[file_view: ...]` or `[file_scroll: ...]` placeholders appear in
   later turns (a tell that shake ran between turns).

You MUST keep scrolling until you have seen line 600. Do not stop early.
If a `file_scroll` returns a placeholder instead of new lines, re-read
that section with a fresh `file_view payload/ledger.jsonl offset=...`.