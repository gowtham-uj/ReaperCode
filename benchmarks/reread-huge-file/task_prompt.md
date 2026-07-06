# Reaper Stress Test — Repeated Rereads of Huge File

You are exercising the file-read cache (mtime+offset dedup). Do EXACTLY
this:

⚠️ DO NOT use `bash`, `grep_search`, `read_file`, or any other tool to
inspect `payload/biglog.txt`. Use ONLY `file_view` and `file_find`. The
goal of this test is to prove the file-read cache dedupes identical
re-reads of the same large file; using `bash` would defeat it.

1. Call `file_view payload/biglog.txt` to read the first 500 lines.
2. Without modifying the file, call `file_view payload/biglog.txt`
   **four more times** (total 5 reads, same path, no offset).
3. After all 5 reads, call `file_find` on `MAGIC_TOKEN_REREAD_12345`
   to locate the needle.
4. Write `out/reread-report.json`:
   ```json
   {
     "reads_attempted": 5,
     "cache_hits_observed": 0,
     "magic_token_line": 12345,
     "file_size_bytes": 3798994
   }
   ```
5. Final assistant message: report how many of the 5 file_view calls
   you believe returned the full inline content vs a stub/placeholder.

Do NOT modify biglog.txt. Do NOT loop with shell. Each read must be a
distinct tool call.