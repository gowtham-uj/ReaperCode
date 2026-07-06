# Backend Indexing

## Hidden requirement 5 — Chunk Sizing

Files must be split into semantic chunks of 200-500 tokens each. Chunks
respect class/def boundaries in Python and function/interface boundaries
in TypeScript.

## Hidden requirement 6 — Cross-reference Index

Build an inverted index mapping every symbol to the files that import it,
so `repomind ask 'where is X used?'` is fast.

## Storage layout
SQLite database at .repomind/index.db with tables: files, chunks, summaries,
symbols, imports, tasks, retrieval_history, context_reports, repo_metadata.
