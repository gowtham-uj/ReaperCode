# Sessions — the ONE conversation mechanism

**Status: authoritative.** This document describes Reaper's single session
mechanism. There is exactly one; the duplicates were deleted on 2026-07-13
so they cannot be extended by mistake (see "What was removed" at the end).
If you are about to add session-like persistence anywhere else in Reaper —
stop and extend `src/context/session-journal.ts` instead.

## Design intent

Reaper is a multi-turn coding agent in the internal-harness/Reaper mold: the user types a
prompt, the model works (tools, edits, verification), the user types the
next prompt, and the model continues **with the same context**. The session
is the durable form of that conversation.

Today there is no TUI. `exec run --session <name>` is the bootstrapping
interface: each invocation is one "user turn" appended to a disconnected
session that resumes by name. A future TUI mounts the SAME sessions —
nothing about the mechanism is exec-specific:

```
                 ┌────────────────────────────┐
   exec --session│                            │  future TUI
  ───────────────►   .reaper/sessions/        ◄───────────────
   one prompt per│   <name>.jsonl (journal)   │  prompt loop in
   process       │                            │  one process
                 └─────────────┬──────────────┘
                               │ boot: rehydrate
                               ▼
                     engine live conversation
                               │ per call: context-engineering layers
                               ▼
                     run end: journal the POST-TRANSFORM delta
```

## Single sources of truth

| Concern | Owner | Nothing else may |
|---|---|---|
| Durable conversation (turns, tool calls, tool results, compaction cuts, branches) | `src/context/session-journal.ts` — one JSONL file per session at `<ws>/.reaper/sessions/<name>.jsonl` | persist conversation turns |
| Rehydration view (what a resumed run feeds the model) | `buildActiveBranchMessages()` in session-journal | reconstruct conversations |
| Session naming rules | `isValidSessionName()` (`[a-zA-Z0-9_.-]{1,128}`) | validate names |
| Cross-run summary store (workspace-wide, unnamed fallback) | `src/context/persistent-summary.ts` → `.reaper/summaries/` | store summaries |
| Unnamed-run resume fallback (summary re-anchor only, no raw turns) | `src/context/session-resume.ts` | build re-anchors |
| Compaction trigger decision | `src/context/should-compact.ts` (`shouldCompact`) | decide when to compact |
| Caps | `src/config/context-hard-cap.ts` (hard + default soft cap, both 270k) | define token caps |

## The journal format

One JSONL file per session. Line 1 is an optional padded title slot, then a
`session` header, then typed entries forming a tree via `(id, parentId)`:

- `message` — payload is a `SessionMessage`: `{ role: user|assistant|tool|system,
  content, tool_call_id?, tool_calls? [{id,name,args}], name?, is_error?, ts? }`.
- `compaction` — payload `{ preChars, postChars, savedChars, resultsShaken,
  summary?, summaryPath?, query? }`. **When `summary` is present, rehydration
  starts here**: the summary REPLACES every message before this entry; only
  messages after it are kept raw (compaction semantics: summary + raw tail).
- `branch`, `branch_summary`, `title_change`, `init` — tree/bookkeeping.

## Lifecycle of a named run

1. **CLI** — `exec run --session <name>` (`src/adaptive/cli.ts` →
   `ExecRunnerOptions.session`, validated fail-fast in `runExec`).
2. **Boot** — `RuntimeEngineInput.namedSession` → `bootPhase0Runtime` →
   `RuntimeStateSchema.namedSession`. The wiring's `onBoot`
   (`src/runtime/context-engineering-wiring.ts`) inits the journal on first
   use and stashes `buildActiveBranchMessages()` output (summary anchor +
   raw tail, including tool turns mapped back to wire format).
3. **Rehydrate** — the engine unshifts the stash BEFORE this run's cockpit
   message, so history precedes the new prompt chronologically, and records
   the prefix length (`<runId>::rehydrated-count`).
4. **Run** — every model call passes through the context-engineering layers
   (below). All transforms mutate the live conversation, which the engine
   snapshots to `<runDir>/live-conversation.json` after every change.
5. **Run end** — `onRunComplete` journals:
   - a `compaction` entry first, if a full summary fired this run
     (`<runId>::last-full-summary` slot set by `applySummary`);
   - then the run's NEW turns: the **post-transform** conversation delta
     (snapshot minus rehydrated prefix; post-compact tail when a summary
     fired). Harness frames never enter the session: the cockpit message is
     replaced by the extracted user intent (`extractUserIntentText`), and
     `[Reaper context boundary]` / `Summary of prior context:` /
     `[Post-compact …]` re-anchor messages are skipped (derivable).

Consequence: **what the layers did to the context is what the session
carries forward.** Shaken tool results persist shaken; superseded reads stay
dropped; a summary becomes the session's new base. The next run does not
re-pay work the layers already did — the internal-harness property.

## Context-engineering layers × sessions

All layers run inside `onBeforeModelCall` on the FULL live conversation —
including rehydrated session history — so session size drives every trigger
from the first call of a resumed run. Token counts are `chars/4` (O200K
heuristic) floored by the last provider-reported input tokens.

Escalation ladder at softCap = 270k (defaults):

| Layer | Trigger | Cost |
|---|---|---|
| supersede prune / tool-output prune | every call | free |
| shake (#6/#7) | 60% of cap; protects newest 64k chars; ≥16k savings | free |
| model promotion (#21) | 50% of cap | swap to larger-context profile |
| **full summary (#10)** | tokens > cap − 16,384 reserve (`shouldCompact`), or forced (idle/incomplete); cooldown 2 tool batches + 8%-cap growth | one out-of-band LLM call (`full-summary-inference.ts`, `models.summarizer` → fallback `default_model`) |
| PTL recovery | provider context-limit error | drops oldest API rounds |

Plus: bash head/tail (>25k chars), artifact spillover (>8KB), time
microcompact (5-min gaps), tool-history compaction (>40 results), budget
notices at 0.70/0.85/0.95.

Only the full summary rewrites the session base (via the compaction entry).
Cheap layers persist implicitly through the post-transform delta.

## Contract for the future TUI

- Open/continue a session: construct `RuntimeEngine` with `namedSession`
  (or call `runExec` with `session`) per user prompt. Nothing else.
- Render history: `buildActiveBranchMessages(ws, name)` — same view the
  model gets.
- List sessions: read `<ws>/.reaper/sessions/*.jsonl` headers.
- Branch/fork: journal `branch`/`branch_summary` entries (tree already
  supports it; `forkSession` exists in session-journal).
- DO NOT add a second store, a per-turn side index, or TUI-private
  conversation state. If the TUI needs a field, add it to the journal entry
  types.

## Verification map

- `tests/integration/named-session.test.ts` — journaling, rehydration
  order, compaction write-back (real HTTP summarizer stub at softCap 2000),
  multi-turn tool-turn round-trip, invalid-name fail-fast, no journal
  without `--session`.
- `tests/unit/days-long-scenario.test.ts` — multi-day journal growth,
  compaction cut semantics, restart durability, 1000-turn perf.
- `tests/unit/session-resume.test.ts` — unnamed summary-fallback contract.
- Live: 10-run MiniMax chain (100% recall every run); 4k-cap 3-run flood
  (summary fired, compaction entry written, codeword recalled post-compact);
  and a **270k-cap mega session** — 287k tokens seeded, first call fired
  shake (−18,459 tokens) then a blocking full summary (1,085,608 →
  13,350 chars), the model completed the next step in a ~4k-token window
  with zero redone work, and the next run booted at 4,136 input tokens
  with verbatim recall of early/middle/late session facts.

## What was removed (do not resurrect)

Deleted 2026-07-13 to enforce the single mechanism:

- `src/session/session-manager.ts` (`ReaperSessionManager`) — a parallel
  Reaper-parity session tree that was never wired to the engine.
- `src/context/session-store.ts` — a directory-per-session store
  (`sessions/<name>/conversation.jsonl`), never wired.
- `src/context/turn-index.ts` — a dead-write turn log; nothing recorded
  into it. `session-resume.ts` was simplified to summaries-only.
- `src/context/compaction/session-compaction.ts` + `prompts.ts` — compaction
  over the deleted session-manager entries.

If you need something they had (tree walks, fork-to-directory, import/
export), port it INTO `session-journal.ts` — the entry format already
models trees, branches, and compaction.
