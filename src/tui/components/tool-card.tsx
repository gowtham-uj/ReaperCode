/**
 * ToolCard — a collapsible card for one tool call. Default collapsed
 * shows the header (tool name + ok/duration); Enter toggles expansion
 * to show args and the result. For mutating tools, the expanded view
 * also shows a DiffCard. For read tools, the result body is shiki-
 * highlighted; for shell tools, stdout stays plain and stderr is red.
 *
 * Pi-style additions (Phase 7 follow-up):
 *   - Background color by state:
 *       pending / running → muted gray
 *       completed ok     → green
 *       failed           → red
 *   - Per-card `expanded` flag stored on the SessionStore so a `Ctrl+L`
 *     clear doesn't drop the user's expansion choice.
 *   - Compact result rendering: successful tool outputs show only the
 *     first N lines (5 by default) when collapsed, full output when
 *     expanded. Error outputs always show in full.
 *
 * Enter on the focused card toggles expansion. Ctrl+D on the focused
 * card toggles the diff view (inline vs side-by-side).
 */

import React from "react";
import { Box, Text, useInput } from "ink";

import { theme } from "../theme.js";
import type { TuiToolCard } from "../types.js";
import { isMutatingTool, diffForToolCall, langForExt } from "../diff-capture.js";
import { highlightBlock, langForPath, type BundledLanguage } from "../syntax-shiki.js";
import { DiffCard } from "./diff-card.js";

interface ToolCardProps {
  card: TuiToolCard;
  workspaceRoot: string;
  /** Optional SessionStore. When provided, Enter-toggled expansion
   *  is mirrored onto the store so the choice survives a `clear()`
   *  or a `toggleToolCard` from elsewhere. Tests can omit the store
   *  and just exercise the local state. */
  store?: import("../state/session-store.js").SessionStore;
}

/** Max lines of a successful tool result to show by default.
 *  Tuned to "enough to recognize the output, not enough to flood
 *  the viewport". The full output is always one Enter away. */
const COMPACT_RESULT_LINES = 5;

function stringify(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function stringifyResult(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Extract a path-shaped string from the args for read tools. */
function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const k of ["path", "filePath", "file"]) {
    const v = a[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Best-effort extraction of a content string from a tool result. */
function extractContent(result: unknown): string | undefined {
  if (!result) return undefined;
  if (typeof result === "string") return result;
  if (typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  for (const k of ["content", "body", "text", "data", "output"]) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Extract stdout/stderr from a run_shell_command-style result. */
interface ShellResultShape { stdout: string | undefined; stderr: string | undefined; code: number | undefined }
function asShellResult(result: unknown): ShellResultShape | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.stdout === "string" || typeof r.stderr === "string") {
    return {
      stdout: typeof r.stdout === "string" ? r.stdout : undefined,
      stderr: typeof r.stderr === "string" ? r.stderr : undefined,
      code: typeof r.code === "number" ? r.code : undefined,
    };
  }
  return null;
}

/**
 * State → background color resolver. Maps the tool-card lifecycle to
 * a Pi-style `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` token.
 * "pending" means the card has been opened (PreToolUse fired) but
 * not closed yet — this is what the TUI sees while the tool is
 * still running. Once a PostToolUse arrives, the card flips to
 * success/failure and the bg color follows.
 */
function bgColorFor(card: TuiToolCard): string | undefined {
  // Card is finished when ok=true (success) OR an error was set
  // (failure). For in-flight cards, ok is false AND error is undefined.
  if (card.error) return "red";
  if (card.ok) return "green";
  // In-flight — muted gray.
  return "gray";
}

/** Truncate a multi-line string to the first `n` lines. */
function truncateLines(s: string, n: number): { text: string; truncated: boolean } {
  const lines = s.split("\n");
  if (lines.length <= n) return { text: s, truncated: false };
  return { text: lines.slice(0, n).join("\n"), truncated: true };
}

function RenderFileContent({ content, path, lang, compact }: { content: string; path: string; lang: BundledLanguage | null; compact: boolean }): React.ReactElement {
  // Compact mode shows only the first COMPACT_RESULT_LINES lines.
  const view = compact ? truncateLines(content, COMPACT_RESULT_LINES) : { text: content, truncated: false };
  // Highlight via shiki when possible.
  if (lang) {
    const lines = highlightBlock(view.text, lang);
    if (lines) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text>{theme.muted(`  ${langForPath(path) ?? "text"} — ${path}`)}</Text>
          {lines.map((ln, li) => (
            <Text key={li} wrap="wrap">{ln}</Text>
          ))}
          {view.truncated ? <Text>{theme.muted(`  … (${content.split("\n").length - COMPACT_RESULT_LINES} more lines — press Enter to expand)`)}</Text> : null}
        </Box>
      );
    }
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>{theme.muted(`  ${path}`)}</Text>
      {view.text.split("\n").map((ln, li) => (
        <Text key={li} wrap="wrap">{ln}</Text>
      ))}
      {view.truncated ? <Text>{theme.muted(`  … (${content.split("\n").length - COMPACT_RESULT_LINES} more lines — press Enter to expand)`)}</Text> : null}
    </Box>
  );
}

function RenderShellOutput({ result, compact }: { result: ShellResultShape; compact: boolean }): React.ReactElement {
  // Compact mode trims stdout to the first COMPACT_RESULT_LINES lines
  // and never truncates stderr (errors should always be visible).
  const stdout = compact && result.stdout !== undefined
    ? truncateLines(result.stdout, COMPACT_RESULT_LINES)
    : { text: result.stdout ?? "", truncated: false };
  return (
    <Box flexDirection="column">
      {result.stdout !== undefined ? (
        <>
          <Text>{theme.muted("stdout:")}</Text>
          <Box flexDirection="column" paddingX={1}>
            {stdout.text.split("\n").map((ln, i) => (
              <Text key={`so-${i}`} wrap="wrap">{ln}</Text>
            ))}
          </Box>
          {stdout.truncated ? <Text>{theme.muted(`  … (${result.stdout!.split("\n").length - COMPACT_RESULT_LINES} more lines — press Enter to expand)`)}</Text> : null}
        </>
      ) : null}
      {result.stderr ? (
        <>
          <Text> </Text>
          <Text>{theme.error("stderr:")}</Text>
          <Box flexDirection="column" paddingX={1}>
            {result.stderr.split("\n").map((ln, i) => (
              <Text key={`se-${i}`} wrap="wrap">{theme.error(ln)}</Text>
            ))}
          </Box>
        </>
      ) : null}
      {result.code !== undefined ? (
        <Text>{theme.muted(`exit code: ${result.code}`)}</Text>
      ) : null}
    </Box>
  );
}

export function ToolCard({ card, workspaceRoot, store }: ToolCardProps): React.ReactElement {
  // Expansion is sourced from the card itself (the store owns the
  // canonical state). The local React state mirrors the prop so
  // toggles via Enter feel snappy; the store re-renders us back to
  // the canonical state on the next mutation.
  const [collapsed, setCollapsed] = React.useState(card.collapsed);
  const [diffMode, setDiffMode] = React.useState<TuiToolCard["diffMode"]>(card.diffMode);

  // Re-sync local state when the prop changes (e.g. a `store.clear()`
  // or a future programmatic collapse).
  React.useEffect(() => {
    setCollapsed(card.collapsed);
  }, [card.collapsed]);
  React.useEffect(() => {
    setDiffMode(card.diffMode);
  }, [card.diffMode]);

  useInput((input, key) => {
    if (input === "\r" || key.return) {
      setCollapsed((c) => {
        const next = !c;
        if (store) {
          try {
            // Mirror to the store so the choice survives future
            // mutations and is consistent with the snapshot.
            if (next) store.expandToolCard(card.id);
            else store.collapseToolCard(card.id);
          } catch {
            /* fail-open */
          }
        }
        return next;
      });
    } else if (key.ctrl && input === "d") {
      setDiffMode((m) => (m === "inline" ? "side-by-side" : "inline"));
    }
  }, { isActive: true });

  const bg = bgColorFor(card);
  const header = (
    <Box flexDirection="row" backgroundColor={bg}>
      <Text>
        {collapsed ? theme.muted("▸ ") : theme.accent("▾ ")}
        {theme.toolHeader(card.name)}
        {theme.muted("  ")}
        {card.ok ? theme.success("ok") : (card.error ? theme.error("err") : theme.muted("…"))}
        {theme.muted(` ${card.durationMs}ms`)}
        {diffMode === "side-by-side" ? theme.muted("  [sbs]") : ""}
      </Text>
    </Box>
  );

  if (collapsed) {
    return (
      <Box flexDirection="column" paddingX={1} backgroundColor={bg}>
        {header}
      </Box>
    );
  }

  const mutating = isMutatingTool(card.name);
  const diff = mutating ? diffForToolCall(card.name, card.args, workspaceRoot) : null;

  // Read tools — highlight content via shiki.
  const isReadTool = card.name === "read_file" || card.name === "view_file" || card.name === "skim_file";
  let readContentEl: React.ReactElement | null = null;
  if (isReadTool) {
    const p = pathFromArgs(card.args);
    const content = extractContent(card.result);
    if (content !== undefined && p !== undefined) {
      const langExt = langForExt(p.replace(/^.*\./, ".")) ?? langForPath(p);
      const lang = (langExt && langExt !== "text" ? langExt : null) as BundledLanguage | null;
      // Compact mode applies when the tool succeeded. Errors always
      // show in full so the user can read the failure context.
      const compact = card.ok && !card.error;
      readContentEl = <RenderFileContent content={content} path={p} lang={lang} compact={compact} />;
    }
  }

  // Shell tools — split stdout/stderr.
  const shellResult = card.name === "bash" ? asShellResult(card.result) : null;
  const shellCompact = card.ok && !card.error;

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="gray" backgroundColor={bg}>
      {header}
      <Box flexDirection="column" paddingLeft={2}>
        <Text>{theme.muted("args:")}</Text>
        <Text wrap="wrap">{stringify(card.args)}</Text>
        <Text> </Text>
        {card.error ? (
          <>
            <Text>{theme.error(`error: ${card.error.code} — ${card.error.message}`)}</Text>
            <Text> </Text>
          </>
        ) : null}
        {diff ? (
          <>
            <Text>{theme.muted("diff:")}</Text>
            <DiffCard diff={diff} mode={diffMode} />
            <Text> </Text>
          </>
        ) : null}
        {readContentEl ? (
          <>
            <Text>{theme.muted("content:")}</Text>
            {readContentEl}
            <Text> </Text>
          </>
        ) : null}
        {shellResult ? (
          <>
            <Text>{theme.muted("output:")}</Text>
            <RenderShellOutput result={shellResult} compact={shellCompact} />
          </>
        ) : null}
        {!readContentEl && !shellResult ? (
          <>
            <Text>{theme.muted("result:")}</Text>
            {(() => {
              const raw = stringifyResult(card.result);
              if (card.ok && !card.error) {
                const view = truncateLines(raw, COMPACT_RESULT_LINES);
                return (
                  <>
                    <Text wrap="wrap">{view.text}</Text>
                    {view.truncated ? <Text>{theme.muted(`  … (${raw.split("\n").length - COMPACT_RESULT_LINES} more lines — press Enter to expand)`)}</Text> : null}
                  </>
                );
              }
              return <Text wrap="wrap">{raw}</Text>;
            })()}
          </>
        ) : null}
      </Box>
    </Box>
  );
}
