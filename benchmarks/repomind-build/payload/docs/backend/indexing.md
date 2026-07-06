# Backend Indexing

## Chunking Strategy

Files are split into semantic chunks of 200–500 tokens each. Chunks
respect natural boundaries:
- Python: class/def boundaries
- TypeScript: function/interface boundaries
- Markdown: heading boundaries

Chunks store the **first** and **last** 100 chars of the source as a
preview; the full chunk is on disk and fetched on demand.

## Hashing

`scanner.py` uses SHA256 (not MD5, not xxhash) for file content
hashing. The reason: SHA256 is in the Python standard library and
collision resistance is more than sufficient for our use case.

## Spillover

For very large files (>30K chars), the file is **persisted to disk**
and the in-DB chunk stores only:
- `head_preview` (first 1.2K chars)
- `tail_preview` (last 1.2K chars)
- `persisted_path` (relative to workspace root)

This is a hard requirement — the DB must not store full large files.

## Dashboard Caching

The web dashboard **must cache** graph results. Computing the
dependency graph on every page load is too expensive. Cache for 5
minutes by default, configurable via `REPO_MIND_CACHE_TTL`.
