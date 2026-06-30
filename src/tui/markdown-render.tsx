/**
 * markdown-render — render a Markdown string as a React node tree
 * suitable for Ink.
 *
 * We use marked's lexer to get a structured token list (so we don't
 * have to re-parse the string in a streaming context) and walk the
 * tokens to produce Ink JSX. Code fences are highlighted via shiki;
 * everything else gets picocolors theming via the TUI theme tokens.
 *
 * Design notes:
 *  - The renderer is a pure function of (markdown, theme, async-highlighter).
 *    No state, no side effects beyond `getHighlighter()` initialization.
 *  - Code blocks render as <Box> with shiki-highlighted ANSI inside
 *    <Text>. The highlighter is loaded async; before it's ready the
 *    renderer falls back to plain <Text> for code blocks (so the rest
 *    of the message still renders).
 *  - We intentionally don't try to be a pixel-perfect Markdown viewer;
 *    the goal is a Codex/Kimi-grade chat experience where code blocks
 *    are colored and everything else is readable.
 */

import React from "react";
import { Box, Text } from "ink";
import { marked, type Tokens, type Token as MarkedToken } from "marked";

import { theme } from "./theme.js";
import { getHighlighter, highlightBlock, type BundledLanguage } from "./syntax-shiki.js";

interface MarkdownProps {
  source: string;
  /** Width hint for wrapping (Ink handles soft-wrap when not set). */
  width?: number;
}

interface BlockState {
  /** Pending language for the next code block. */
  pendingCodeLang?: BundledLanguage | string;
  /** Lines accumulated for the current code block. */
  pendingCodeLines: string[];
}

function tokenKind(t: Tokens.Generic): string {
  return (t as { type?: string }).type ?? "unknown";
}

function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function tokenPlainText(tok: MarkedToken): string {
  switch (tok.type) {
    case "text":
      return decodeHtmlEntities((tok as Tokens.Text).text).replace(/\\n/g, "\n");
    case "codespan":
      return decodeHtmlEntities((tok as Tokens.Codespan).text);
    case "link":
      return decodeHtmlEntities((tok as Tokens.Link).text);
    case "image":
      return decodeHtmlEntities((tok as Tokens.Image).text);
    case "strong":
      return (tok as Tokens.Strong).tokens.map(tokenPlainText).join("");
    case "em":
      return (tok as Tokens.Em).tokens.map(tokenPlainText).join("");
    case "del":
      return (tok as Tokens.Del).tokens.map(tokenPlainText).join("");
    case "paragraph":
      return ((tok as Tokens.Paragraph).tokens ?? []).map(tokenPlainText).join("");
    case "heading":
      return ((tok as Tokens.Heading).tokens ?? []).map(tokenPlainText).join("");
    case "list_item":
      return ((tok as Tokens.ListItem).tokens ?? []).map(tokenPlainText).join("");
    default: {
      const t = tok as { text?: string };
      return typeof t.text === "string" ? decodeHtmlEntities(t.text) : "";
    }
  }
}

function tokensToPlainText(tokens: MarkedToken[]): string {
  return tokens.map((tok) => tokenPlainText(tok)).join("");
}

async function highlightCode(lang: string, code: string): Promise<string[]> {
  // Force-init the highlighter; if it throws or the lang is unsupported,
  // fall back to plain text.
  try {
    const h = await getHighlighter();
    const result = h.codeToTokens(code, {
      lang: (lang || "text") as BundledLanguage,
      theme: "github-dark",
    });
    const ANSI_RESET = "\x1b[0m";
    const out: string[] = [];
    for (const line of result.tokens) {
      let row = "";
      for (const tok of line) {
        const color = (tok as { color?: string }).color;
        const content = (tok as { content?: string }).content ?? "";
        if (color && content) {
          // Inline escape translation — duplicated here to avoid an
          // import cycle with syntax-shiki.tsx.
          const h2 = color.startsWith("#") ? color.slice(1) : color;
          if (h2.length >= 6) {
            const r = parseInt(h2.slice(0, 2), 16);
            const g = parseInt(h2.slice(2, 4), 16);
            const b = parseInt(h2.slice(4, 6), 16);
            if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
              row += `\x1b[38;2;${r};${g};${b}m${content}${ANSI_RESET}`;
              continue;
            }
          }
          row += content;
        } else if (content) {
          row += content;
        }
      }
      out.push(row);
    }
    return out;
  } catch {
    return code.split("\n");
  }
}

function renderInline(tokens: MarkedToken[], keyPrefix: string): React.ReactNode {
  return tokens.map((tok, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text;
        // Replace literal "\n" with a real newline for inline soft breaks.
        return <Text key={k}>{decodeHtmlEntities(t.text).replace(/\\n/g, "\n")}</Text>;
      }
      case "strong": {
        const t = tok as Tokens.Strong;
        return <Text key={k} bold>{renderInline(t.tokens, k)}</Text>;
      }
      case "em": {
        const t = tok as Tokens.Em;
        return <Text key={k} italic>{renderInline(t.tokens, k)}</Text>;
      }
      case "del": {
        const t = tok as Tokens.Del;
        return <Text key={k} strikethrough>{renderInline(t.tokens, k)}</Text>;
      }
      case "codespan": {
        const t = tok as Tokens.Codespan;
        return <Text key={k}>{theme.accent("`")}{theme.muted(decodeHtmlEntities(t.text))}{theme.accent("`")}</Text>;
      }
      case "link": {
        const t = tok as Tokens.Link;
        return <Text key={k}>{theme.accent(decodeHtmlEntities(t.text))} {theme.muted(`(${t.href})`)}</Text>;
      }
      case "image": {
        const t = tok as Tokens.Image;
        return <Text key={k}>{theme.muted(`[image: ${decodeHtmlEntities(t.text)}](${t.href})`)}</Text>;
      }
      case "br": {
        return <Text key={k}>{"\n"}</Text>;
      }
      case "escape": {
        const t = tok as Tokens.Escape;
        return <Text key={k}>{t.text}</Text>;
      }
      case "html": {
        const t = tok as Tokens.HTML;
        return <Text key={k}>{theme.muted(decodeHtmlEntities(t.text))}</Text>;
      }
      default: {
        // Generic / unknown — fall back to text if available.
        const t = tok as { text?: string };
        return <Text key={k}>{t.text ?? ""}</Text>;
      }
    }
  });
}

function tokensToBlocks(tokens: MarkedToken[]): React.ReactNode {
  const out: React.ReactNode[] = [];
  let paraBuffer: MarkedToken[][] = [];

  const flushParagraph = () => {
    if (paraBuffer.length === 0) return;
    const plain = paraBuffer.map((inline) => tokensToPlainText(inline)).join("").trim();
    if (!plain) {
      paraBuffer = [];
      return;
    }
    const children = paraBuffer.flatMap((inline) => renderInline(inline, "p"));
    out.push(
      <Box key={`p-${out.length}`} flexDirection="row" paddingX={0}>
        <Text wrap="wrap">{children}</Text>
      </Box>,
    );
    paraBuffer = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    switch (tok.type) {
      case "paragraph": {
        paraBuffer.push((tok as Tokens.Paragraph).tokens ?? []);
        // The next iteration or end-of-input flushes the buffer.
        if (i === tokens.length - 1) flushParagraph();
        break;
      }
      case "heading": {
        flushParagraph();
        const t = tok as Tokens.Heading;
        const prefix = "#".repeat(t.depth);
        out.push(
          <Box key={`h-${out.length}`} flexDirection="row" marginTop={1}>
            <Text bold>{theme.accent(prefix)} {theme.toolHeader(t.text)}</Text>
          </Box>,
        );
        break;
      }
      case "code": {
        flushParagraph();
        const t = tok as Tokens.Code;
        // Synchronous highlight if highlighter is ready; otherwise
        // render plain and let the parent re-render after init.
        const lines = highlightBlock(t.text, (t.lang || "text") as BundledLanguage);
        if (lines) {
          out.push(
            <Box key={`code-${out.length}`} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
              {t.lang ? <Text>{theme.muted(`  ${t.lang}`)}</Text> : null}
              {lines.map((ln, li) => (
                <Text key={`c-${out.length}-${li}`} wrap="wrap">{ln}</Text>
              ))}
            </Box>,
          );
        } else {
          out.push(
            <Box key={`code-${out.length}`} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
              {t.lang ? <Text>{theme.muted(`  ${t.lang}`)}</Text> : null}
              {t.text.split("\n").map((ln, li) => (
                <Text key={`c-${out.length}-${li}`} wrap="wrap">{ln}</Text>
              ))}
            </Box>,
          );
        }
        break;
      }
      case "blockquote": {
        flushParagraph();
        const t = tok as Tokens.Blockquote;
        const inner = tokensToBlocks(t.tokens ?? []);
        out.push(
          <Box key={`bq-${out.length}`} flexDirection="column" paddingLeft={2} borderStyle="single" borderColor="gray">
            {inner}
          </Box>,
        );
        break;
      }
      case "list": {
        flushParagraph();
        const t = tok as Tokens.List;
        const items = t.items
          .map((it: Tokens.ListItem, li: number) => ({ it, li }))
          .filter(({ it }) => tokensToPlainText(it.tokens ?? []).trim().length > 0)
          .map(({ it, li }) => {
          const marker = t.ordered ? `${li + (typeof t.start === "number" ? t.start : 1)}.` : "•";
          const text = tokensToPlainText(it.tokens ?? []).trim();
          return (
            <Box key={`li-${out.length}-${li}`} flexDirection="row">
              <Text>{theme.accent(marker)} </Text>
              <Text wrap="wrap">{text}</Text>
            </Box>
          );
        });
        out.push(
          <Box key={`l-${out.length}`} flexDirection="column">{items}</Box>,
        );
        break;
      }
      case "hr": {
        flushParagraph();
        out.push(
          <Box key={`hr-${out.length}`} flexDirection="row">
            <Text>{theme.muted("─".repeat(40))}</Text>
          </Box>,
        );
        break;
      }
      case "table": {
        flushParagraph();
        const t = tok as Tokens.Table;
        const headerCells = t.header.map((cell: Tokens.TableCell, ci: number) => (
          <Text key={`th-${ci}`} bold>{theme.toolHeader(decodeHtmlEntities(cell.text))}</Text>
        ));
        const rows = t.rows.map((row: Tokens.TableCell[], ri: number) => (
          <Box key={`tr-${ri}`} flexDirection="row">
            {row.map((cell: Tokens.TableCell, ci: number) => (
              <Text key={`td-${ri}-${ci}`}>{decodeHtmlEntities(cell.text)}  </Text>
            ))}
          </Box>
        ));
        out.push(
          <Box key={`t-${out.length}`} flexDirection="column" marginY={1}>
            <Box flexDirection="row">{headerCells}</Box>
            <Text>{theme.muted("─".repeat(20))}</Text>
            {rows}
          </Box>,
        );
        break;
      }
      case "html": {
        flushParagraph();
        const t = tok as Tokens.HTML;
        out.push(<Text key={`html-${out.length}`}>{theme.muted(t.text)}</Text>);
        break;
      }
      case "space": {
        // Whitespace separator between blocks.
        flushParagraph();
        break;
      }
      default: {
        // Unknown token — drop silently.
        break;
      }
    }
  }
  flushParagraph();
  return out;
}

export function MarkdownRender({ source }: MarkdownProps): React.ReactElement {
  if (!source || !source.trim()) return <Text>{""}</Text>;
  let tokens: MarkedToken[];
  try {
    tokens = marked.lexer(source);
  } catch {
    // If marked fails, fall back to plain rendering.
    return <Text wrap="wrap">{source}</Text>;
  }
  return <Box flexDirection="column">{tokensToBlocks(tokens)}</Box>;
}

/** Async variant — useful when we want to ensure the shiki highlighter
 *  is ready before rendering code blocks. Currently unused; the
 *  synchronous renderer falls back gracefully when shiki isn't ready. */
export async function MarkdownRenderAsync({ source }: MarkdownProps): Promise<React.ReactElement> {
  await getHighlighter();
  return <MarkdownRender source={source} />;
}
