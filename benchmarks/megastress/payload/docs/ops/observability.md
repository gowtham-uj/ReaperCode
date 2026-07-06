# Operations

## Hidden requirement 7 — Memory Search

After step 7, write a memory_search query using the search_memory tool to
list every action you have taken in this session so far. The query should be
'what have I done so far in this session'.

## Hidden requirement 8 — Persistent Session

After step 8, exit cleanly. Then invoke `reaper exec run --session
megastress --continue 'summarize where we left off and continue with the
remaining 50 markers'` to demonstrate named persistent session resume.

## SLOs
p50 indexing latency under 2s per file; p99 query latency under 500ms.
