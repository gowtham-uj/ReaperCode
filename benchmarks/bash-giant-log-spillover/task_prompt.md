# Reaper Stress Test — Giant Bash Output + Spillover

You are stress-testing bash output persistence + spillover. Do this:

1. Generate a giant log file by running the shell generator at
   `benchmarks/bash-giant-log-spillover/gen_log.sh` (relative to your
   workspace root) and then `cat` it from disk with bash.
   The script outputs ~1.5 MB (~380,000 tokens). To make bash actually
   return that as stdout, run:
   ```
   bash -lc "bash \$WORKSPACE/benchmarks/bash-giant-log-spillover/gen_log.sh && cat /tmp/reaper-stress-bash-giant-log-spillover.log | head -c 1500000"
   ```
   Adjust `\$WORKSPACE` to your actual workspace path. Expected stdout
   length: ~1,500,000 chars (~380,000 tokens).
2. The runtime should persist the full output to
   `.reaper/artifacts/bash/<id>.txt` and return only the first ~1,200
   chars inline, plus a `logPath` field.
3. After you see the preview, use `read_file` (or `file_scroll`) on the
   `logPath` to find the line containing the token `value=0000000000000000000000000000000000000000000000000000000000004242`.
   (That value is `printf '%064d' 1060`.)
4. Write `out/spillover-report.json`:
   ```json
   {
     "bash_persist_path": "<the path the bash result reported>",
     "preview_chars_seen": 1200,
     "full_output_bytes": 1500000,
     "needle_line_identified": true,
     "spillover_artifact_present": true
   }
   ```
5. Final message: state whether you had to read the persisted log file
   separately to find the needle, or whether the inline preview was
   sufficient.