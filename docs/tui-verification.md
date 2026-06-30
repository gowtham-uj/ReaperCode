# TUI Verification Report — Phases 3, 4, 5 + Graph View

Date: 2026-06-18

## Scope

This report covers the Phase 3 (diff viewer + syntax highlighting),
Phase 4 (input + slash palette), and Phase 5 (polish + session resume)
work, plus the Pi-style `/history` graph overlay added on top of Phase 5.

## Typecheck

`node_modules/.bin/tsc --noEmit` reports zero errors in `src/tui/`.
The 25 remaining errors across the repo are pre-existing and out of
scope for the TUI build:

| File | Errors |
|------|--------|
| `tests/unit/tools/skill-authoring-tools.test.ts` | 13 |
| `tests/unit/delegate-to-planner.test.ts` | 4 |
| `src/planner/planner.ts` | 3 |
| `tests/unit/system-prompt.test.ts` | 1 |
| `tests/unit/json-response.test.ts` | 1 |
| `tests/unit/execution-planner.test.ts` | 1 |
| `src/tools/write/delegate-to-planner.types.ts` | 1 |
| `src/runtime/subagent-prompt-logger.ts` | 1 |

## Unit tests

`node --import tsx --test tests/unit/tui/*.test.ts`

```
# tests 15
# pass 15
# fail 0
# duration_ms ~470ms
```

| File | Tests | Pass |
|------|-------|------|
| `session-graph.test.ts` | 4 | 4 |
| `sessions-store.test.ts` | 5 | 5 |
| `diff-capture.test.ts` | 6 | 6 |

Coverage:

- **session-graph**: parses 2-turn trajectories with mixed outcomes
  (ok/err/pending), returns null for missing file, handles empty file,
  tool outcome mapping (completed→ok, failed→err, pending→pending).
- **sessions-store**: save/load roundtrip, returns null for missing,
  list returns newest first, list respects limit, ensureSessionsDir
  creates the directory.
- **diff-capture**: write_file produces an add hunk, edit_file produces
  ctx+del+add, replace_in_file maps the same way, non-mutating tools
  return null, isMutatingTool covers the mutating set, langForExt maps
  common extensions and returns undefined for unknown.

## Feature verification

### Phase 3 — Diff viewer + syntax highlighting

- `src/tui/diff-capture.ts` — `diffForToolCall(name, args, root)` builds
  a unified diff client-side from `(path, oldContent, newContent)` via
  the `diff` package; `langForExt(ext)` returns a shiki lang id
  (`ts`, `ts`, `js`, `json`, `python`, `md`, `yaml`, `rust`, `go`,
  `bash`, `diff`) for known extensions; `isMutatingTool(name)` covers
  `write_file`, `edit_file`, `replace_in_file`, `create_file`.
- `src/tui/syntax-shiki.tsx` — singleton `getHighlighter()` with
  lazy + concurrent-safe init; `getHighlighterSync()` for render-time
  use; `highlightBlock(code, lang, theme)` returns
  `string[] | null` (ANSI-escaped lines) with hex→24-bit translation
  and an LRU cache; `langForPath(p)` maps file paths to BundledLanguage.
- `src/tui/markdown-render.tsx` — walks `marked.lexer()` tokens and
  renders headings, paragraphs, code fences (via shiki when lang
  known, plain otherwise), blockquotes, lists, hr, tables, and inline
  formatting (strong, em, codespan, link, br, escape).
- `src/tui/components/diff-card.tsx` — inline diff with `+`/`-`/` `
  prefixes; side-by-side variant; per-token shiki coloring layered on
  top of the prefix color.
- `src/tui/components/tool-card.tsx` — collapsible; mutating tools
  show the diff; `read_file` / `view_file` / `skim_file` highlight the
  rendered content via shiki when the lang is known; shell tools split
  stdout (plain) and stderr (red) with exit code.
- `src/tui/components/message-card.tsx` — routes assistant messages
  through `<MarkdownRender>`.

### Phase 4 — Input + slash palette

- `src/tui/hooks/use-paste.ts` — bracketed-paste parser state machine
  (`ESC[200~ ... ESC[201~`) on `process.stdin.on("data")` (bypasses
  Ink's keypress parser); CRLF→LF normalization; emits one `onPaste`
  event via `setImmediate`; no-op when stdin isn't a TTY.
- `src/tui/components/reverse-search-popover.tsx` — Codex-style
  `Ctrl-R` popover; ↑/↓ moves the match index, Enter commits,
  Esc cancels, backspace on empty cancels.
- `src/tui/components/slash-popover.tsx` — already-supported
  `description?` rendering carried over from the prior pass.
- `src/tui/components/input-prompt.tsx` — `Tab` completion,
  `Shift+Enter` / `Ctrl-J` newline, ↑/↓ history walk, Esc abort;
  duplicate `Ctrl-C` handler removed so App's double-press logic owns it.

### Phase 5 — Polish + session resume + graph view

- `src/tui/app.tsx` — `usePaste` integration; `<ReverseSearchPopover>`
  above the input; double `Ctrl-C` exit with a 1.5s window (first press
  sets `exitHint`, second press calls `app.unmount()`); synthetic
  `__GRAPH_OPEN__` / `__SESSION_RESUME__` messages filtered out of the
  visible message list and intercepted in a `useEffect` that flips
  the layout to `<GraphView>`.
- `src/tui/components/status-bar.tsx` — ink-spinner for `streaming`
  and `tool-running` phases; renders phase glyph/spinner · model ·
  provider · ctx% · tokens · elapsed (if > 0) · session · active tools
  count · last tool outcome; hint appears as a second warning row.
- `src/tui/theme.ts` — `lightTheme` palette added; `REAPER_TUI_THEME`
  env var selects dark (default) or light; both palettes stay legible
  on 16-color terminals by using bold + inverse for emphasis.
- `src/tui/sessions-store.ts` — persists session metadata at
  `<workspaceRoot>/.reaper/sessions/<id>.json`; `saveSession`,
  `loadSession`, `listSessions(limit)`, `sessionsDir`,
  `ensureSessionsDir`.
- `src/tui/render.tsx` — hydrates `HistoryBuffer` from
  `<workspaceRoot>/.reaper/tui-history.json` on startup; persists
  `history.snapshot()` on Ink unmount; registers three slash commands:
  - `/history [id]` — builds the session graph via
    `buildSessionGraph(meta.trajectoryPath)` and emits the synthetic
    `__GRAPH_OPEN__ <id> <nodes> <turns>` signal via `host.printError`.
  - `/sessions` — lists the 20 most recent sessions via `host.print`.
  - `/resume <id>` — emits the synthetic `__SESSION_RESUME__ <id>`
    signal.
- `src/tui/session-graph.ts` — reads trajectory JSONL, groups
  envelopes into turns by `turn_id`, walks `tool_call` →
  `{kind: "tool", outcome: ok|err|pending}` and `assistant_message` →
  `{kind: "assistant"}`; `user_prompt` is the turn boundary.
  Returns `null` for missing/empty files.
- `src/tui/components/graph-view.tsx` — Pi-inspired ASCII tree with
  `├─` / `└─` / `│` connectors; `buildLines(graph, collapsed)`
  computes depth + `isLast` for connector calc; color-coded by node
  kind and tool outcome (green ✓ ok, red ✗ err, yellow … pending);
  ↑/↓ selection, ←/→ collapse toggle, Enter activate, q/Esc close.

## Manual e2e checklist

These are the operations a reviewer should run after `npm install &&
npm run build && npm link`:

- `reaper` → Ink TUI opens, status bar at the bottom, input prompt at
  the top.
- Type a prompt → assistant reply streams in with rendered markdown
  + shiki code blocks.
- Ask for a `write_file` + `run_shell_command` flow → tool cards for
  `write_file` (with diff) and `run_shell_command` (with stdout) appear
  inline; status bar flips `streaming` → `tool-running` → `done`.
- `/reload` → slash popover appears; commits; system message appears.
- `/history` → graph view opens with the current session; ↑/↓ navigate,
  ←/→ collapse subtrees, Enter activate, q/Esc close.
- `Ctrl-R` → reverse-search popover opens; type to filter history,
  Enter commits, Esc cancels.
- Paste a multi-KB block → bracketed paste arrives as one insert event
  (no per-character splitting).
- `Esc` mid-run → in-flight tool call aborts (the engine's `abortSignal`
  is wired through `Hooks`).
- `Ctrl-C` twice within 1.5s → TUI exits cleanly.
- `reaper exec run --prompt "echo hi" --workspace /tmp/foo` →
  still works exactly as before; no engine modification.

## Headless regression

The TUI build touches `src/adaptive/cli.ts` (adds the `tui` case) and
`src/extensions/registry.ts` (stashes panel/diff-renderer registrations
so future plugins can register). It does not touch
`src/adaptive/exec-runner.ts:275 runExec()`,
`src/tools/executor.ts`, or the engine. The headless `reaper exec run`
path remains bit-identical.

## Known follow-ups

- **Token-by-token model streaming** — engine still returns the final
  assistant string; per-tool streaming via Hooks is enough liveness for
  the first cut. Future PR wires `gateway.stream()` directly.
- **Light theme CLI flag** — currently selected via env var; a
  `--theme light` flag on `reaper` would be a nicer interface.
- **Image previews** — `view_file` returns text only; image preview
  needs engine support.
- **Plugin panels** — `ExtensionPanelRegistration` contract is wired,
  but no example panel ships in this build.
- **Side-by-side diff on narrow terminals** — current threshold is
  80 cols; auto-fallback to inline below that.