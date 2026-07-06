# Product Specification

## Hidden requirement 3 — Audit Logs

Every `repomind task` execution must write an audit log entry under
.repomind/audit/<timestamp>.json with the user prompt, model, action list,
and exit status.

## Hidden requirement 4 — Dashboard Cache

The FastAPI dashboard must cache graph results for at least 60 seconds
so repeated /graph requests don't re-walk the dependency graph.

## CLI surface
`repomind index <path>`, `repomind ask <q>`, `repomind task <t>`, `repomind serve`.
