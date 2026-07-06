# Product Specification

## CLI Surface

`repomind` is a single binary exposing four subcommands. Every
subcommand is a real, executable file under the `repomind/` Python
package — no symlinks, no shell wrappers.

## Database Schema

`db.py` is the source of truth for the SQLite schema. Every other
module reads/writes via the helpers in `db.py`. Do not call `sqlite3`
directly from `scanner.py` or `retriever.py`.

## Error Handling

Errors must never silently truncate output. If a file is too large to
read in one chunk, return a pointer to the persisted log + the first
1.2K chars + the last 1.2K chars. This is the "head+tail" strategy
(cc-haha) and ensures the user sees both the start (errors usually
appear early) and the end (results usually appear at the end) of any
large output.

## Audit Logging

The `repomind task` subcommand **must** write audit logs. Every
`task` invocation creates a row in the `tasks` table with: id,
command, start_time, end_time, files_modified, exit_code, error.
This is required for compliance and debugging.
