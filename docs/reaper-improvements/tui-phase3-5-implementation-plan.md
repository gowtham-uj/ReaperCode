# Reaper TUI — Phases 3-5 Unified Implementation Plan

**Workspace:** `/workspace`
**TUI source root:** `/workspace/src/tui/`
**Current task state:** Phase 3 completed; Phase 4 in_progress; Phase 5 in_progress; Verification pending.
**Document purpose:** Single ordered, file-level delivery plan that lets an implementer execute phases 3, 4, and 5 in sequence without mid-flight churn.

---

## 0. Inputs this plan was synthesized from

1. **Survey / overarching plan** — `/workspace/reaper_design/phased-implementation-plan.md` (Phase 3 = safe mutation; but in TUI context the survey pegged Phase 3 as **Diff viewer + syntax highlighting**, Phase 4 as **Input + slash palette**, Phase 5 as **Polish + session resume**).
2. **Phase 3 result** — `/workspace/src/tui/syntax-shiki.tsx`, `/workspace/src/tui/diff-capture.ts`, `/workspace/src/tui/components/diff-card.tsx`, `/workspace/src/tui/components/tool-card.tsx` already implement diff capture, shiki-backed highlighting, inline vs side-by-side toggle, and read-tool highlighting.
3. **Phase 4 result** — `/workspace/src/tui/components/input-prompt.tsx`, `/workspace/src/tui/components/slash-popover.tsx`, `/workspace/src/tui/components/reverse-search-popover.tsx`, `/workspace/src/tui/components/help-overlay.tsx`, `/workspace/src/tui/hooks/use-paste.ts`, `/workspace/src/tui/state/history.ts`, `/workspace/src/tui/app.tsx` already wire ink-text-input, slash completion, Ctrl-R reverse-i-search, paste, and the help overlay.
4. **Phase 5 result** — `/workspace/src/tui/state/session-store.ts`, `/workspace/src/tui/state/abort.ts`, `/workspace/src/tui/components/status-bar.tsx` already implement the store, abort slot, and animated status bar; the remaining Phase 5 work is **scrollable virtualized message list** + **session resume** (`HistoryBuffer.hydrate`, store persistence).

The plan below therefore treats Phase 3 as **complete (verify only)**, Phase 4 as **stabilization + integration**, and Phase 5 as the remaining **forward work**.

---

## 1. Roll-out principle (read first)

To minimize mid-flight churn we apply three rules:

1. **New files first.** All new components, hooks, and persistence modules are written before any existing file is edited.
2. **Modifications to existing files last.** Edits to `app.tsx`, `session-store.ts`, etc. only land after the new files exist and type-check in isolation.
3. **Typecheck gate at every phase boundary.** `tsc --noEmit` must pass before the next phase begins. A failing gate blocks forward motion — phase exit criteria are hard gates.

We also designate **shared infrastructure to land in Phase 3** (which is the phase whose remaining work is "verify"), specifically the **shiki singleton** in `syntax-shiki.tsx`. Phase 4 and Phase 5 will both consume this singleton; consolidating it early avoids duplication.

---

## 2. Shared infrastructure (must exist before any phase writes)

Already present and reusable across all three phases:

| Path | Purpose | Used by |
|---|---|---|
| `/workspace/src/tui/syntax-shiki.tsx` | **Singleton shiki highlighter** + `langForPath`, `highlightBlock`, `getHighlighterSync`, `disposeHighlighter` | Phase 3 (ToolCard/DiffCard) ✓, Phase 4 (markdown in MessageCard) ✓, Phase 5 (render-as-you-scroll) |
| `/workspace/src/tui/theme.ts` | Centralised color palette + helpers (`theme.muted`, `theme.success`, etc.) | All phases |
| `/workspace/src/tui/types.ts` | `TuiStatus`, `TuiMessage`, `TuiToolCard`, `TuiDiff`, `TuiSnapshot` | All phases |
| `/workspace/src/tui/state/session-store.ts` | `SessionStore`, `createSessionStore`, listener model | All phases |
| `/workspace/src/tui/state/history.ts` | `HistoryBuffer` with `push`, `up/down`, `search`, `snapshot`, `hydrate` | Phase 4 ✓, Phase 5 (resume) |
| `/workspace/src/tui/state/abort.ts` | `makeAbortSlot` (per-prompt `AbortController`) | Phase 4 ✓, Phase 5 (mid-stream scroll) |
| `/workspace/src/tui/hooks/use-paste.ts` | Bracketed-paste handler | Phase 4 ✓ |

**No new shared infrastructure needs to be created** — the singleton pattern in `syntax-shiki.tsx` is the only candidate, and it already exists.

---

## 3. Phase 3 — Diff viewer + syntax highlighting (verification pass)

**Status:** implementation complete. Remaining work is **verification, hardening, and tests**.

### 3.1 Files to verify (no writes expected unless failures found)

| Path | Purpose | Key exports / props | Notes |
|---|---|---|---|
| `/workspace/src/tui/syntax-shiki.tsx` | Singleton shiki wrapper | `getHighlighter`, `getHighlighterSync`, `highlightBlock`, `highlightLine`, `highlightBlockAsync`, `langForPath`, `disposeHighlighter`, `SUPPORTED_LANGS`, `SUPPORTED_THEMES` | Already a singleton — Phase 4 markdown and Phase 5 scroll reuse this directly. |
| `/workspace/src/tui/diff-capture.ts` | Capture before/after for write tools | `diffForToolCall`, `isMutatingTool`, `langForExt` | |
| `/workspace/src/tui/components/diff-card.tsx` | Inline + side-by-side diff renderer | `<DiffCard diff mode="inline"\|"side-by-side" maxLines? />` | Re-exports `getHighlighterSync` for App.tsx. |
| `/workspace/src/tui/components/tool-card.tsx` | Collapsible tool card with diff + read highlight | `<ToolCard card workspaceRoot />`; toggles via `Enter` (collapsed) and `Ctrl-D` (diff mode). | |
| `/workspace/src/tui/markdown-render.tsx` | Markdown render of assistant messages | `<MarkdownRender source />` | Used by `MessageCard`. |

### 3.2 Phase 3 new test files (write only if missing)

| Path | Purpose |
|---|---|
| `/workspace/tests/unit/tui/diff-capture.test.ts` | Verify `diffForToolCall` produces correct hunks for `write_file`, `replace_in_file`, `delete_file`; `isMutatingTool` returns correct set. |
| `/workspace/tests/unit/tui/syntax-shiki.test.ts` | Verify `langForPath` mapping; `highlightBlock` returns null when highlighter not ready; `getHighlighter` is idempotent (concurrent calls return same handle). |
| `/workspace/tests/unit/tui/diff-card.test.ts` | Verify inline renders +/-/hunk prefixes; side-by-side pairs correctly; long diffs show truncation message. |
| `/workspace/tests/unit/tui/tool-card.test.ts` | Verify collapse toggle, diff-mode toggle, stdout/stderr split for shell, shiki fallback for read. |

### 3.3 Phase 3 verification gate

```
pnpm tsc --noEmit              # must pass with 0 errors
pnpm test tests/unit/tui      # all four test files must pass
```

If any file above is rewritten as part of fixes, re-run the gate before exiting Phase 3.

---

## 4. Phase 4 — Input + slash palette (stabilization + integration)

**Status:** implementation complete. Remaining work is wiring hardening, edge-case fixes, and tests.

### 4.1 New files to write (none expected; verify the list)

Phase 4 should not require any new files. If, during integration, you discover you need them, candidate paths are:

| Path | Purpose | Key exports / props | Notes |
|---|---|---|---|
| `/workspace/src/tui/hooks/use-bracketed-paste-vt.ts` | (Only if `use-paste.ts` proves insufficient.) Lower-level VT/CSI parser for `\x1b[200~…\x1b[201~`. | `useBracketedPaste(handler)` | Defer until proven needed. |

### 4.2 Files to modify

| Path | Modification | Depends on |
|---|---|---|
| `/workspace/src/tui/app.tsx` | (a) Verify `registryEntries` correctly maps `SlashCommandRegistry.list()` rows to `SlashEntry` (with description); (b) confirm double Ctrl-C timer (1500 ms) clears the hint; (c) confirm Ctrl-L `store.clear()` does not blow away status. | `SessionStore`, `SlashCommandRegistry`, `TuiHost` |
| `/workspace/src/tui/components/input-prompt.tsx` | (a) Verify `showPopover` only when `slashEntries.length > 0`; (b) verify Tab accepts slash completion; (c) verify history walk preserves live draft via `history.up(value)`/`history.down()`. | `HistoryBuffer`, `SlashPopover` |
| `/workspace/src/tui/components/slash-popover.tsx` | (a) Center windowed slice on selected; (b) ensure `padEnd(24)` aligns with help-overlay. | `SlashEntry` |
| `/workspace/src/tui/components/reverse-search-popover.tsx` | (a) Verify backspace on empty needle cancels; (b) verify matchIdx reset when needle changes. | `HistoryBuffer.search` |
| `/workspace/src/tui/components/help-overlay.tsx` | Update `SLASH_HINTS` and `KEYBINDS` arrays to reflect the Phase 5 additions (scroll, resume). | `KEYBINDS`, `SLASH_HINTS` |
| `/workspace/src/tui/hooks/use-paste.ts` | No functional change expected; ensure single listener. | `useApp` |

### 4.3 Phase 4 new test files

| Path | Purpose |
|---|---|
| `/workspace/tests/unit/tui/slash-popover.test.ts` | Windowed rendering; selected row highlights with `accent`; hidden when empty. |
| `/workspace/tests/unit/tui/input-prompt.test.ts` | Tab accepts slash completion; Enter on empty input is no-op; Shift+Enter inserts newline. |
| `/workspace/tests/unit/tui/reverse-search-popover.test.ts` | Empty needle returns most-recent first; arrow up/down moves within matches; backspace on empty cancels. |
| `/workspace/tests/unit/tui/app-keybinds.test.ts` | Ctrl-R opens popover; Ctrl-C twice exits; Ctrl-L clears store. |
| `/workspace/tests/unit/tui/use-paste.test.ts` | Single-shot paste inserts the whole block (preserving newlines). |

### 4.4 Phase 4 verification gate

```
pnpm tsc --noEmit
pnpm test tests/unit/tui
# Plus integration: drive the App via ink-testing-library and
# assert that typing "/" shows the popover and Tab commits.
pnpm test tests/integration/tui-app.test.ts   # if added
```

**Cross-phase dependency flagged:** Phase 5's `MessageList` scroll behavior depends on the **final `MessageList` API from Phase 3** (`messages: TuiMessage[]; maxLines: number; optional scrollOffset?`). Phase 4 does not touch `MessageList`, so this is a no-op dependency, but Phase 5 must not break the Phase 3 contract.

---

## 5. Phase 5 — Polish + session resume (the remaining forward work)

**Status:** implementation in progress. This phase is the bulk of the remaining work.

### 5.1 New files to write

| Path | Purpose | Key exports / props | Depends on |
|---|---|---|---|
| `/workspace/src/tui/components/scrollable-message-list.tsx` | **Virtualized viewport** — renders only the slice of `messages` between `scrollOffset` and `scrollOffset + maxLines`. PageUp/PageDown/Home/End adjust `scrollOffset`. | `<ScrollableMessageList messages maxLines scrollOffset onScrollOffsetChange />` | `TuiMessage`, `MessageCard` |
| `/workspace/src/tui/state/session-persistence.ts` | Save and load a session: messages, tool cards (status only — no result bodies), status, history. JSON on disk under `~/.reaper/sessions/<sid>.json`. | `saveSession(store, history): Promise<void>`, `loadSession(sid): Promise<{messages, toolCards, status, history} \| null>` | `SessionStore`, `HistoryBuffer` |
| `/workspace/src/tui/hooks/use-scroll-controls.ts` | Encapsulates keybind → `scrollOffset` math, keeps the viewport pinned to bottom when user is at-bottom and a new message arrives. | `useScrollControls({messageCount, maxLines}): { scrollOffset, onKey, pinnedToBottom }` | `useInput` |
| `/workspace/src/tui/hooks/use-session-restore.ts` | On mount, optionally restores from a passed `resumeFromSessionId?`; on every state change (debounced), calls `saveSession`. | `useSessionRestore(store, history, opts?: { resumeFromSessionId?: string; debounceMs?: number })` | `session-persistence`, `SessionStore` |
| `/workspace/src/tui/components/resume-banner.tsx` | Tiny non-modal banner shown above the input when a session was restored from disk: `"resumed session ses_xxx — N messages restored"`. Has a `(dismiss)` affordance. | `<ResumeBanner text onDismiss />` | `theme` |
| `/workspace/src/tui/commands/resume.ts` | Slash command wiring: `/resume [sessionId]` opens a session by id (or lists last 5 if no id given). | `registerResumeCommand(registry, ctx)` | `session-persistence`, `SlashCommandRegistry` |

**Order in which these files land** (Phase 5 internal ordering to keep typecheck green at each step):

1. `state/session-persistence.ts` — pure data; no UI deps. Typecheckable standalone.
2. `hooks/use-scroll-controls.ts` — pure hook; depends only on `useInput`. Typecheckable standalone.
3. `components/scrollable-message-list.tsx` — depends on `use-scroll-controls` and `MessageCard`. Typecheckable once step 2 lands.
4. `hooks/use-session-restore.ts` — depends on `session-persistence` and `SessionStore`. Typecheckable once step 1 lands.
5. `components/resume-banner.tsx` — pure presentational. Typecheckable standalone.
6. `commands/resume.ts` — depends on `session-persistence` and `SlashCommandRegistry`. Typecheckable once step 1 lands.

### 5.2 Files to modify (last, after the new files typecheck)

| Path | Modification | Depends on |
|---|---|---|
| `/workspace/src/tui/components/message-list.tsx` | **Refactor to thin wrapper** around `ScrollableMessageList`. Keep the existing `props: { messages, maxLines }` so the Phase 3 contract holds; add optional `scrollOffset?: number` and `onScrollOffsetChange?: (n: number) => void` props (default behavior: pin to bottom). | `scrollable-message-list` |
| `/workspace/src/tui/app.tsx` | (a) Mount `<ScrollableMessageList>` (or via `MessageList`); (b) wire `useSessionRestore(store, history, { resumeFromSessionId })` driven by an optional App prop; (c) render `<ResumeBanner>` when `store` reports it was restored. | `session-persistence`, `use-session-restore`, `resume-banner`, `commands/resume` |
| `/workspace/src/tui/state/session-store.ts` | (a) Add `restore(snapshot: { messages, toolCards, status })` method; (b) add `wasRestored: boolean` to `TuiStatus` (or expose via a one-shot getter) so the resume banner can render exactly once. | `TuiStatus`, `TuiMessage`, `TuiToolCard` |
| `/workspace/src/tui/types.ts` | (a) Add `wasRestored?: boolean` to `TuiStatus`; (b) add optional `scrollOffset?: number` to `MessageListProps`. | — |
| `/workspace/src/tui/components/help-overlay.tsx` | Append `["PgUp/PgDn", "scroll message list"]`, `["/resume [id]", "resume a previous session"]`, `["Home/End", "jump to start/end of message list"]`. | `KEYBINDS` |
| `/workspace/src/tui/extensions/slash-command-registry.ts` (or wherever commands are registered) | Register `resume` from `commands/resume.ts`. | `commands/resume` |

**Cross-phase dependency flagged:** `MessageList` keeps its Phase 3 props (`messages`, `maxLines`) and gains optional `scrollOffset`. App.tsx's call sites from Phase 3 must continue to compile unchanged.

### 5.3 Phase 5 new test files

| Path | Purpose |
|---|---|
| `/workspace/tests/unit/tui/scrollable-message-list.test.ts` | Renders only the windowed slice; PageUp moves offset; Home jumps to 0; End jumps to bottom. |
| `/workspace/tests/unit/tui/use-scroll-controls.test.ts` | Pin-to-bottom when new message arrives and viewport was at-bottom; stays put if user scrolled away. |
| `/workspace/tests/unit/tui/session-persistence.test.ts` | Round-trips `SessionStore` snapshot + `HistoryBuffer` through JSON; corrupt JSON returns null (not throws). |
| `/workspace/tests/unit/tui/session-store-restore.test.ts` | `restore()` hydrates messages, toolCards, status; emits one notify; `wasRestored` flips true then false after banner dismiss. |
| `/workspace/tests/unit/tui/commands/resume.test.ts` | `/resume` (no args) lists last 5 sessions; `/resume ses_xxx` loads and returns ok; unknown id returns ok:false with error. |
| `/workspace/tests/integration/tui-session-resume.test.ts` | End-to-end: launch App with a fresh session, send prompts, save, re-launch with `resumeFromSessionId`, assert messages and history restored. |

### 5.4 Phase 5 verification gate

```
pnpm tsc --noEmit
pnpm test tests/unit/tui tests/integration/tui-session-resume.test.ts
# Manual:
node --loader ts-node/esm src/cli/reaper-tui.ts --resume <ses_id>
# Assert: banner appears; scrolling works; new prompt increments session.
```

---

## 6. Final verification (task #285)

After Phase 5 gate passes:

1. **Typecheck:** `pnpm tsc --noEmit` exits 0.
2. **Unit tests:** `pnpm test tests/unit/tui` exits 0.
3. **Integration tests:** `pnpm test tests/integration/tui*` exits 0.
4. **Manual e2e:**
   - Launch fresh session, send 3 prompts, observe diffs, scroll back, send a slash command, observe popover, press `?`, observe help, Ctrl-C twice to exit.
   - Re-launch with `--resume`, observe banner, scroll to old message, send new prompt, observe new message appended, exit.
5. **Coverage:** `pnpm test --coverage tests/unit/tui` reports ≥80% lines for `components/`, `state/`, `hooks/`.

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Ink rerender storms** — scrolling triggers full re-render of the message list. | Medium | Use `React.memo` on `MessageCard` keyed by `msg.id`; window at the `ScrollableMessageList` layer, not at the `MessageCard` layer. |
| **shiki init blocks first render** — highlighter is async. | Medium | `getHighlighterSync()` returns null on cold start; `highlightBlock` returns null; renderers fall back to plain text. Resume banner only shows after restore, by which point the highlighter is ready. |
| **Persistence write contention** — autosave on every notify could thrash disk. | Medium | `useSessionRestore` debounces writes (default 750 ms) and writes are atomic (`fs.writeFile` to temp + rename). |
| **Cross-phase API drift** — Phase 5 changes `MessageList` props break Phase 3 callers. | Low | Phase 5 adds optional props only; the `messages` and `maxLines` required props are untouched. Typecheck gate at Phase 3 boundary catches regressions. |
| **Double Ctrl-C race** — rapid presses could exit before the hint clears. | Low | The 1500 ms window is enforced by `lastCtrlC` ref; the timer in `useEffect` only clears the hint, not the ref. |
| **Resume on a session with non-replayable tool cards** — diff capture requires the original file on disk. | Medium | On restore, mark tool cards as `result: undefined`, `collapsed: true`, and suppress diff rendering (`diffForToolCall` already returns null when `workspaceRoot` file is missing). |
| **Virtualization off-by-one** — clip first/last line of the visible slice. | Low | Render `slice(scrollOffset, scrollOffset + maxLines)` and pad with one extra line above and below for continuity. |
| **Type drift in `TuiStatus`** — adding `wasRestored` could break consumers. | Low | Make `wasRestored?: boolean` optional and default to `false`; existing call sites unchanged. |

---

## 8. Out of scope (explicitly NOT building)

These are **deliberately excluded** from Phases 3-5:

1. **Model token streaming** — `streaming` phase glyph is rendered, but no per-token UI (no caret, no char-by-char fade-in). The TUI consumes final assistant messages; per-token animation is a later polish item.
2. **Image previews** — no inline image rendering in message cards, no image attachments in paste handler. Plain text and shiki-highlighted code only.
3. **MCP tool integration** — `mcp/` under `src/tools/` is untouched. TUI shows whatever the tool registry exposes; no MCP-aware UI.
4. **Vim / Emacs keybindings** — modal input, normal/insert mode, marks, registers, etc. are explicitly out.
5. **Multi-pane layouts** — no split panes, no side-by-side sessions, no detached windows. Single full-screen TUI.
6. **Plugin panels** — no pluggable sidebar/footer widgets, no third-party panel API. Status bar and help overlay are fixed.
7. **Session branching / forking** — `/resume` loads a single linear session; no fork, no timeline scrubbing.
8. **Collaborative cursors / multi-user** — single-user only.
9. **Mouse support** — keyboard only; no clickable buttons, no scroll-wheel handling.
10. **i18n / l10n** — English-only labels and keybind hints.

---

## 9. Summary checklist

- [ ] Phase 3 verification gate passes (`tsc` + `tests/unit/tui/diff-*` + `tests/unit/tui/syntax-shiki.test.ts` + `tests/unit/tui/tool-card.test.ts`).
- [ ] Phase 4 verification gate passes (existing files unchanged; new tests cover slash popover, input prompt, reverse search, keybinds, paste).
- [ ] Phase 5 new files written in dependency order: `state/session-persistence.ts` → `hooks/use-scroll-controls.ts` → `components/scrollable-message-list.tsx` → `hooks/use-session-restore.ts` → `components/resume-banner.tsx` → `commands/resume.ts`.
- [ ] Phase 5 modifications to existing files land last: `components/message-list.tsx`, `app.tsx`, `state/session-store.ts`, `types.ts`, `components/help-overlay.tsx`, slash-command-registry.
- [ ] Phase 5 verification gate passes (unit + integration + manual `--resume`).
- [ ] Final task #285 verification: typecheck, all tests, manual e2e both fresh and resumed sessions.