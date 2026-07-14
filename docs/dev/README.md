# Reaper developer docs

This directory collects internal, contributor-facing documentation that is not
appropriate for end users.

| File | What it covers |
|---|---|
| `adding-tools.md` | The full checklist for adding a new tool to Reaper's main-agent surface. Lists every file that has to know the tool name, the silent failure modes we have already hit, and a verification recipe. |
| `roadmap-v0.1.4-tool-port.md` | Tool-architecture evolution phases. |
| `sessions.md` | **The single session mechanism** — journal format, `exec --session` lifecycle, context-engineering × session sync, compaction write-back, TUI contract, and the deleted duplicates that must not come back. |
| `tier-5-branch-summary-deferred.md` | Branch-summarization layer — currently deferred; explains why and what porting it would take. |

## Why this directory exists

Reaper's tool surface is threaded through ~10 separate locations. Most of the bugs
we have hit while porting the viewer tools presented as "the model emits the call
correctly, but the runtime silently drops it." Each of those failures traced to a
single missing edit in one of those locations.

`adding-tools.md` exists so the next contributor does not have to rediscover the
same drift points in the same order.