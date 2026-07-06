# Reaper Stress Test — Many Write Acks + Cache Continuity

You are testing that shake prunes write_file acks aggressively without
busting the model's prompt-cache prefix.

Steps:

1. `file_view payload/big-readme.txt` (full 500-line window).
2. `file_scroll` (down, 500) twice to see the whole file.
3. Confirm `ACCOUNT_ID=ACME-998877` is on line 1 and that you can see
   the canary string `CACHE_PREFIX_CANARY=CACHE-OK-XYZZY` at line 200.
4. Create 50 files using `write_file`:
   - `out/chunk-00.txt` through `out/chunk-49.txt`
   - each containing exactly one non-empty line copied verbatim from a
     distinct section of the README
5. After all 50 writes, write `out/acks-report.json`:
   ```json
   {
     "files_written": 50,
     "account_id_seen": "ACME-998877",
     "canary_seen": true,
     "ack_chars_before_shake": 1500,
     "ack_chars_after_shake": 250
   }
   ```
6. Final message: report whether any `write_file` result was replaced by
   a `[write_file: <path>]` placeholder by the time you were halfway
   through the writes.