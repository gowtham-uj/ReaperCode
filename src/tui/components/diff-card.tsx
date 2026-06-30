/**
 * DiffCard — renders a unified (inline) or side-by-side diff of
 * `before` vs `after` for a single file. Each diff line is highlighted
 * via shiki when the highlighter is ready, and falls back to plain
 * colored prefixes when it isn't. Toggle inline vs side-by-side via
 * the `mode` prop (driven by Ctrl-D on the parent ToolCard).
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import { highlightBlock, getHighlighterSync, langForPath, type BundledLanguage } from "../syntax-shiki.js";
import type { TuiDiff, TuiDiffHunk, TuiDiffLine } from "../types.js";

interface DiffCardProps {
  diff: TuiDiff;
  mode: "inline" | "side-by-side";
  /** Soft cap on the number of rendered lines; longer diffs show
   *  "... N more lines hidden". */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 200;

function lineColor(kind: TuiDiffLine["kind"]): (s: string) => string {
  switch (kind) {
    case "add":
      return theme.diffAdd;
    case "del":
      return theme.diffDel;
    case "ctx":
      return theme.diffCtx;
    case "hunk":
      return theme.diffHunk;
  }
}

function kindPrefix(kind: TuiDiffLine["kind"]): string {
  switch (kind) {
    case "add":  return "+ ";
    case "del":  return "- ";
    case "hunk": return "@@ ";
    case "ctx":  return "  ";
  }
}

/** Render one line of a diff. If shiki is ready and the diff has a
 *  known language, the line text gets per-token coloring on top of
 *  the +/-/hunk/ctx prefix color. */
function renderDiffLine(
  ln: TuiDiffLine,
  lang: BundledLanguage | null,
  key: string,
): React.ReactNode {
  const base = lineColor(ln.kind);
  const prefix = kindPrefix(ln.kind);
  if (lang && ln.kind !== "hunk") {
    const highlighted = highlightBlock(ln.text, lang);
    if (highlighted && highlighted.length === 1) {
      return (
        <Text key={key} wrap="wrap">
          {base(prefix)}
          {highlighted[0]}
        </Text>
      );
    }
  }
  return (
    <Text key={key} wrap="wrap">
      {base(prefix)}
      {base(ln.text)}
    </Text>
  );
}

function renderInline(hunks: TuiDiffHunk[], lang: BundledLanguage | null, maxLines: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let shown = 0;
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (shown >= maxLines) {
        out.push(
          <Text key={`more-${shown}`}>{theme.muted(`... ${maxLines}+ more lines (Ctrl-D toggles side-by-side)`)}</Text>,
        );
        return out;
      }
      out.push(renderDiffLine(ln, lang, `${shown}-${ln.text}`));
      shown += 1;
    }
  }
  return out;
}

interface SideBySideRow {
  old: { kind: TuiDiffLine["kind"]; text: string } | null;
  new: { kind: TuiDiffLine["kind"]; text: string } | null;
}

function pairHunks(hunks: TuiDiffHunk[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (ln.kind === "hunk") continue;
      if (ln.kind === "ctx") {
        rows.push({ old: ln, new: ln });
      } else if (ln.kind === "del") {
        rows.push({ old: ln, new: null });
      } else if (ln.kind === "add") {
        rows.push({ old: null, new: ln });
      }
    }
  }
  return rows;
}

function renderSideBySide(hunks: TuiDiffHunk[], lang: BundledLanguage | null, maxLines: number): React.ReactNode[] {
  const rows = pairHunks(hunks);
  const out: React.ReactNode[] = [];
  const limit = Math.min(rows.length, maxLines);
  for (let i = 0; i < limit; i++) {
    const r = rows[i]!;
    const oldPrefix = r.old ? (r.old.kind === "del" ? "- " : "  ") : "  ";
    const newPrefix = r.new ? (r.new.kind === "add" ? "+ " : "  ") : "  ";
    const oldColor = r.old ? lineColor(r.old.kind) : theme.muted;
    const newColor = r.new ? lineColor(r.new.kind) : theme.muted;

    let oldContent: React.ReactNode = "";
    let newContent: React.ReactNode = "";
    if (r.old && lang) {
      const hl = highlightBlock(r.old.text, lang);
      if (hl && hl.length === 1) oldContent = hl[0]!;
    }
    if (!oldContent && r.old) oldContent = oldColor(r.old.text);
    if (r.new && lang) {
      const hl = highlightBlock(r.new.text, lang);
      if (hl && hl.length === 1) newContent = hl[0]!;
    }
    if (!newContent && r.new) newContent = newColor(r.new.text);

    out.push(
      <Box key={`sbs-${i}`} flexDirection="row" width="100%">
        <Box width="50%">
          <Text wrap="wrap">{r.old ? oldColor(oldPrefix) : theme.muted(" ")}{oldContent}</Text>
        </Box>
        <Box width="50%">
          <Text wrap="wrap">{r.new ? newColor(newPrefix) : theme.muted(" ")}{newContent}</Text>
        </Box>
      </Box>,
    );
  }
  if (rows.length > maxLines) {
    out.push(
      <Text key="more">{theme.muted(`... ${rows.length - maxLines} more rows`)}</Text>,
    );
  }
  return out;
}

export function DiffCard({ diff, mode, maxLines = DEFAULT_MAX_LINES }: DiffCardProps): React.ReactElement {
  const lang: BundledLanguage | null = diff.language
    ? (diff.language as BundledLanguage)
    : langForPath(diff.path);
  const renderLang: BundledLanguage | null = lang;
  if (diff.hunks.length === 0) {
    return <Text>{theme.muted("(no textual changes)")}</Text>;
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>{theme.toolHeader(diff.path)} </Text>
        <Text>{theme.muted(`(${diff.hunks.length} hunk${diff.hunks.length === 1 ? "" : "s"})`)}</Text>
      </Box>
      {mode === "inline"
        ? renderInline(diff.hunks, renderLang, maxLines)
        : renderSideBySide(diff.hunks, renderLang, maxLines)}
    </Box>
  );
}

/** Re-exported for App.tsx so it can avoid importing shiki directly. */
export { getHighlighterSync };