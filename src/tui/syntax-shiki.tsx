/**
 * shiki-highlighter — singleton wrapper around shiki's createHighlighter
 * for the Reaper TUI.
 *
 * Shiki's bundle ships every language (~50MB) by default. We register
 * only the 16 languages the Reaper codebase actually uses (plus plain
 * text) and the 2 dark themes that compose with our TUI palette.
 *
 * The highlighter is initialized lazily on first call to `getHighlighter`
 * so the TUI mounts instantly even before any code is rendered. The
 * resulting handle is cached process-wide — there is no per-render cost
 * beyond `codeToTokens`.
 *
 * The shiki `codeToTokens` API returns tokens with `color` (hex) on
 * each segment. We pre-translate hex → ANSI truecolor escapes at first
 * call and cache the lookup by hex so per-token work stays O(1).
 */

import React from "react";
import { Text } from "ink";
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";

export type { BundledLanguage, BundledTheme };

export const SUPPORTED_LANGS: BundledLanguage[] = [
  "ts", "tsx", "js", "jsx", "json", "jsonc",
  "bash", "sh", "shell",
  "python", "py",
  "md", "markdown",
  "yaml", "yml", "toml",
  "rust", "go", "java", "ruby", "php",
  "html", "css", "scss", "sql",
  "diff",
];

export const SUPPORTED_THEMES: BundledTheme[] = ["github-dark", "github-light"];

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

/** Lazily initialize the singleton. Idempotent and concurrent-safe. */
export async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const h = await createHighlighter({
      themes: SUPPORTED_THEMES,
      langs: SUPPORTED_LANGS,
    });
    highlighter = h;
    return h;
  })();
  return initPromise;
}

/** Best-effort synchronous accessor. Returns null if the highlighter
 *  isn't ready yet — callers fall back to plain rendering. */
export function getHighlighterSync(): Highlighter | null {
  return highlighter;
}

/** Release the highlighter. Called from Ink unmount to free WASM. */
export async function disposeHighlighter(): Promise<void> {
  if (!highlighter) return;
  const h = highlighter;
  highlighter = null;
  initPromise = null;
  try {
    h.dispose();
  } catch {
    /* swallow */
  }
}

/** Detect a shiki lang id from a file path. Falls back to "text". */
export function langForPath(p: string): BundledLanguage {
  const lower = p.toLowerCase();
  const m = lower.match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "";
  switch (ext) {
    case "ts":  return "ts";
    case "tsx": return "tsx";
    case "js":  return "js";
    case "jsx": return "jsx";
    case "mjs": case "cjs": return "js";
    case "json": case "jsonc": return "json";
    case "sh": case "bash": case "zsh": return "bash";
    case "py":  return "python";
    case "md": case "markdown": return "md";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
    case "rs":  return "rust";
    case "go":  return "go";
    case "java": return "java";
    case "rb":  return "ruby";
    case "php": return "php";
    case "html": case "htm": return "html";
    case "css": return "css";
    case "scss": return "scss";
    case "sql": return "sql";
    case "diff": case "patch": return "diff";
    default:    return "text" as BundledLanguage;
  }
}

/** Translate a shiki hex color (e.g. "#ff7b72") to an ANSI 24-bit escape. */
function hexToAnsi(hex: string): string {
  // Hex may come through as "#rrggbb" or already wrapped.
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) return "";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return "";
  return `\x1b[38;2;${r};${g};${b}m`;
}

const ANSI_RESET = "\x1b[0m";
const ansiCache = new Map<string, string>();
function ansiFor(hex: string): string {
  const cached = ansiCache.get(hex);
  if (cached !== undefined) return cached;
  const v = hexToAnsi(hex);
  ansiCache.set(hex, v);
  return v;
}

/** Highlight one line of code (no newlines inside). Returns a string
 *  with ANSI escapes applied. Returns null when shiki isn't ready or
 *  the lang isn't supported — callers fall back to plain rendering. */
export function highlightLine(code: string, lang: BundledLanguage, theme: BundledTheme = "github-dark"): string | null {
  const h = highlighter;
  if (!h) return null;
  if (!SUPPORTED_LANGS.includes(lang)) return null;
  try {
    const result = h.codeToTokens(code, { lang, theme });
    let out = "";
    for (const line of result.tokens) {
      for (const tok of line) {
        const color = (tok as { color?: string }).color;
        const content = (tok as { content?: string }).content ?? "";
        if (color && content) {
          out += ansiFor(color) + content + ANSI_RESET;
        } else if (content) {
          out += content;
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Highlight a multi-line block. Returns an array of per-line strings
 *  with ANSI escapes applied (one entry per input line). Returns null
 *  on failure or when the highlighter isn't ready. */
export function highlightBlock(code: string, lang: BundledLanguage, theme: BundledTheme = "github-dark"): string[] | null {
  const h = highlighter;
  if (!h) return null;
  if (!SUPPORTED_LANGS.includes(lang)) return null;
  try {
    const result = h.codeToTokens(code, { lang, theme });
    const out: string[] = [];
    for (const line of result.tokens) {
      let row = "";
      for (const tok of line) {
        const color = (tok as { color?: string }).color;
        const content = (tok as { content?: string }).content ?? "";
        if (color && content) {
          row += ansiFor(color) + content + ANSI_RESET;
        } else if (content) {
          row += content;
        }
      }
      out.push(row);
    }
    return out;
  } catch {
    return null;
  }
}

/** Async variant that waits for the highlighter to initialize before
 *  returning. Use when the TUI is rendering for the first time and
 *  the highlighter hasn't loaded yet. */
export async function highlightBlockAsync(code: string, lang: BundledLanguage, theme: BundledTheme = "github-dark"): Promise<string[]> {
  const h = await getHighlighter();
  try {
    const result = h.codeToTokens(code, { lang, theme });
    const out: string[] = [];
    for (const line of result.tokens) {
      let row = "";
      for (const tok of line) {
        const color = (tok as { color?: string }).color;
        const content = (tok as { content?: string }).content ?? "";
        if (color && content) {
          row += ansiFor(color) + content + ANSI_RESET;
        } else if (content) {
          row += content;
        }
      }
      out.push(row);
    }
    return out;
  } catch {
    return [code];
  }
}

/** Render pre-highlighted ANSI strings inside Ink <Text>. The string
 *  already contains escape codes — we just hand it to <Text>. */
export function HighlightedText({ ansi, dimColor }: { ansi: string; dimColor?: boolean }): React.ReactElement {
  return <Text dimColor={dimColor ?? false}>{ansi}</Text>;
}