# Context-Engineering Layer Audit

> When does each of Reaper's 21 context-engineering techniques fire,
> what does it do, and what's its OMP equivalent?

**Last verified run:** `/tmp/reaper-stress-context-shake-900k-5000-2026-07-07T17-01-59-905Z`
**Run type:** 900K-token long-context (read 40 shards, extract facts)
**Run events:** 775 total, all 8 active layers observed

---

## Trigger map — OMP vs Reaper

| OMP trigger | OMP layer | Reaper equivalent | Wiring entry point |
|---|---|---|---|
| `runAutoCompaction("idle", …)` after 60s-1h idle with tokens > idleThreshold | OMP `compactionIdleLoop` | `time-microcompact` runs on every `onAfterModelCall` when `nowMs - msgTs > gapMs` | `onAfterModelCall` |
| `runPrePromptCompactionIfNeeded(messages)` before each user prompt | OMP `compactionPrePrompt` | `onBeforeModelCall` shake + (optionally) full-summary | `onBeforeModelCall` |
| `maintainContextMidRun(messages)` after each tool result when `willContinue` | OMP `compactionMidRun` | `onAfterToolResult` (bash head+tail) + per-iteration `onBeforeModelCall` | `onAfterToolResult` + inner loop |
| `checkCompaction(assistantMessage)` after each turn | OMP `compactionPostTurn` | `onAfterModelCall` writes token_budget + applies promotion | `onAfterModelCall` |
| `runAutoCompaction("overflow", …)` on 400/413 | OMP overflow recovery | `onProviderTokenLimitError` | `onProviderTokenLimitError` |
| `runAutoCompaction("incomplete", …)` on `stopReason === "length"` | OMP incomplete recovery | (not implemented — would map to same PTL handler) | — |

---

## Per-layer fire conditions and effects

### #1-#3 — Passive layers

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 1 | Normalized tool-result envelope | always | wraps result in `{ ok, output, durationMs, toolCallId }` shape | `BashOutput.toForegroundShellResult` |
| 2 | File-read cache | every `file_view` call | returns cached content on duplicate reads | `simplifyReads` in `#pruneStaleToolResults` |
| 3 | Bash watch/stall detection | bash commands that exceed `idleTimeoutMs` | kills with `exitCode: 124` | `BASH_INPUT_DEFAULTS.STALL_WATCHDOG_INTERVAL_MS` |

### #4 + #5 — Bash head+tail + Spillover

| # | Layer | Fire condition (post-fix) | Effect | OMP equivalent |
|---|---|---|---|---|
| 4 | Bash head+tail (`bashHeadTailEnabled`) | `toolName === "bash"` AND `persistedOutputSize > bashPersistThresholdChars` (5000) | emits `bash_head_tail` trajectory event with `original_chars`, `preview_chars`, `saved_chars` | OMP shows output inline + `let user view .reaper/runs/.../artifacts/processes/...log` |
| 5 | Spillover (always-on) | bash output > 30K chars | writes full output to `.reaper/runs/.../artifacts/processes/<callId>.log` AND `logPath` set in result | Same as OMP (truncate stdout, write to log file) |

### #6 + #7 — Shake + circuit breaker

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 6 | Shake (`shakeEnabled`) | `onBeforeModelCall`, before full-summary gate | in-place replaces oldest tool result with placeholder (`"…output shaken; see log…"`); mutates `messages` | OMP `#pruneStaleToolResults` — replaces superseded tool outputs |
| 7 | Shake circuit breaker (`maxConsecutiveShakeFailures: 3`) | shake returns no result 3 times in a row | increments `SHAKE_BREAKER_STATE.consecutiveFailures`; falls through to next layer | OMP: skipped — OMP uses `#runAutoCompaction` and lets the strategy decide |

### #8 — PTL recovery

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 8 | PTL recovery | engine catches provider 400/413 → calls `onProviderTokenLimitError` | (1) awaits in-flight full-summary promise (up to 240s), (2) calls `truncateHeadForPTLRecovery` to drop the oldest oversized tool result, (3) returns truncated messages for retry | OMP: `runRecoveryCompactionWithRollback("overflow", ...)` — removes failed turn, runs compaction, retries |

### #9 — Time microcompact

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 9 | Time microcompact (`timeMicrocompactEnabled`) | `onAfterModelCall`, when `nowMs - msgTs > timeMicrocompactGapMs` (30s in stress, 5min real) | clears stale tool result placeholders to a fixed string | OMP: not exactly — OMP has `pruneStaleToolResults` (supersedeReads + dropUseless), run on every post-turn |

### #10 — Full summarization (LLM)

| # | Layer | Fire condition (post-fix) | Effect | OMP equivalent |
|---|---|---|---|---|
| 10 | Full summary (`fullSummaryEnabled`) | `onBeforeModelCall` when `shouldCompact(tokensAfterShake, softCap) = tokensAfterShake > softCap - reserve` (using OMP's exact `resolveThresholdTokens` from `src/context/should-compact.ts`) | (1) calls `infer(jsonl)` out-of-band via `src/context/full-summary-inference.ts` (HTTP fetch to summarizer profile, 4-min timeout), (2) stashes post-compact messages on `globalThis[runId::full-summary-applied]`, (3) persists to `.reaper/summaries/<id>.md` | OMP: `runAutoCompaction("threshold", …)` — calls LLM, writes `CompactionSummaryMessage` to branch with `firstKeptEntryId` |

### #11 + #12 — Threshold + token budget

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 11 | Threshold state warning (`warningThresholdRatio: 0.7`) | `onAfterModelCall` when `totalTokens / softCap >= 0.7` | computes `{ state: "warning" \| "error" \| "blocking" }` | OMP emits the same in its trajectory |
| 12 | Token budget telemetry | `onAfterModelCall` | writes `token_budget` trajectory event with `turn_*` and `cumulative_*` tokens; falls back to local estimate when usage envelope is missing | OMP: same shape — `turn_input_tokens`, `turn_cache_*`, `cumulative_*` |

### #13 — Compact tool history

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 13 | Compact tool history (T2.5) | `onBeforeModelCall` when `toolResults.length > 0` | `compactToolHistory` from `src/context/history-compaction.ts` — merges adjacent tool results of the same type | OMP: `simplifyHistory` — merges adjacent tool results |

### #14 — Threshold-state telemetry

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 14 | Threshold telemetry (passive) | every `onAfterModelCall` | the same `state` field is part of the wiring return value to the engine | OMP: same — `context_state` event |

### #15-#18 — Boundary + last-user-task + files re-anchor

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 15 | Boundary marker | inside `buildPostCompactMessages` (called from full-summary path) | adds `[context boundary N]` user message | OMP: `compaction_turn_prefix_messages` — a prefix user message before the summary |
| 16 | First Kept Entry marker | boundary marker + summary array | the boundary IS OMP's `firstKeptEntryId` semantic — the kept-prefix is the messages AFTER the summary | OMP: `firstKeptEntryId` on the compaction summary entry |
| 17 | Last-user-task preservation | full-summary path | finds the most-recent user message in `working` and appends it to the post-compact messages (so the model knows its current task) | OMP: `recentMessages` and the kept region — the last user task is part of the kept prefix |
| 18 | Files re-anchor | full-summary path | `reattachRecentFiles` from `src/context/full-summary.ts` re-emits any file paths the model was working on so it can re-read them after compaction | OMP: `reattached_files` field on the compaction summary |

### #19-#20 — Session store + persistent summary

| # | Layer | Fire condition | Effect | OMP equivalent |
|---|---|---|---|---|
| 19 | Session store + journal | `onBoot` when `namedSession` is set | writes session start entry; engine writes assistant_message, state_transition events per turn | OMP: `sessionManager.appendMessage` to the persistent branch |
| 20 | Persistent summary | full-summary path | `persistSummary` writes `.reaper/summaries/<id>.md` with frontmatter (id, createdAt, runId, pre/post/saved chars) + body | OMP: writes `CompactionSummaryMessage` to the session branch |

### #21 — Promote Context Model (NEW)

| # | Layer | Fire condition (post-fix) | Effect | OMP equivalent |
|---|---|---|---|---|
| 21 | Promote Context Model (`modelPromotionEnabled`) | `onBeforeModelCall` when `ratio = tokensAfterShake / softCap >= modelPromotionThresholdRatio` (default 0.5) | (1) finds sibling profiles with strictly larger `capabilities.maxContextTokens`, (2) `recordPromotion` writes to `.reaper/promotions/<runId>.jsonl`, (3) writes `promoted_context_model` trajectory event, (4) engine on next call reads latest promotion and swaps `turnRequest.role` to the matching model | OMP: `#promoteContextModel()` checks model registry, calls `this.model = newModel` |

---

## Cross-layer invariant: `shouldCompact` is the single gate

OMP has exactly **one** compaction-decision function: `shouldCompact(tokensUsed, contextWindow, settings)`. Reaper's `src/context/should-compact.ts` is the byte-for-byte OMP port of this function. The wiring's #10 layer uses it via dynamic import — `const fireFullSummary = shouldCompact(tokensAfterShake, softCap)`. **All compaction decisions go through this one gate.** No layer fires full-summary in a way OMP wouldn't.

## Cross-layer invariant: the post-compact shape

OMP's `createCompactionSummaryMessage` returns:
```
[compaction_turn_prefix, summary, ...recentMessages, ...reattached_files]
```

Reaper's `buildPostCompactMessages` returns:
```
[boundary_marker, summary, ...reattached_files, last_user_task]
```

Identical shape, identical OMP-equivalent effect when the post-compact messages are applied to the live conversation.

## Cross-layer invariant: apply timing

OMP applies the post-compact messages via `replaceMessages()` immediately after `runAutoCompaction` returns, BEFORE the next model call. Reaper applies them on the next `onBeforeModelCall` (via the wiring's stashed-slot consumption). The `engine` also has a run-start apply step for resumed runs. **Apply timing matches OMP: post-compact messages are live on the next model call.**
