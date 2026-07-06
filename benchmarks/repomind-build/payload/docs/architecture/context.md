# Context Engineering Architecture

## Retrieval Philosophy

The retrieval engine must prefer **summaries over raw files** whenever
possible. A good summary is 10–50× smaller than the raw file and
covers the same essential information.

When you select context for a question, ask yourself: can I answer this
from a 1-paragraph summary, or do I need the actual file bytes? Start
with summaries. Escalate to chunks only when the summary is insufficient.

## Incremental Indexing

The scanner **must** support incremental indexing. Re-running
`repomind index` on a repository that hasn't changed should be a no-op
except for new files. The mtime + SHA256 strategy is recommended.

The DB stores both `path`, `mtime`, and `sha256` per file. On re-index,
files with the same `(path, sha256)` are skipped. Files with new
sha256 are re-hashed. New paths are added.

## Threshold State

The retrieval engine should expose a `threshold_state` field in
`context_report.json`:
- `ok` when used < 70% of budget
- `warning` at 70%
- `error` at 85%
- `blocking` at 95%

This mirrors cc-haha's `calculateTokenWarningState` and is what
surfaces the "context is filling up" warning in the UI.
