/**
 * Theme tokens for the Reaper TUI. Defaults to a dark-terminal
 * palette; a light palette ships for terminals with light
 * backgrounds. The active theme is selected by the `REAPER_TUI_THEME`
 * env var (default "dark").
 *
 * The TUI components use these tokens directly; picocolors handles
 * the actual escape-sequence emission.
 *
 * picocolors emits 8/16-color ANSI codes by default; we use bold +
 * inverse for emphasis rather than relying on color depth. Both
 * palettes stay legible on terminals that render only the standard
 * 16-color palette.
 */

import pc from "picocolors";

export interface TuiTheme {
  accent: (s: string) => string;
  muted: (s: string) => string;
  error: (s: string) => string;
  success: (s: string) => string;
  warning: (s: string) => string;
  user: (s: string) => string;
  assistant: (s: string) => string;
  system: (s: string) => string;
  toolHeader: (s: string) => string;
  diffAdd: (s: string) => string;
  diffDel: (s: string) => string;
  diffCtx: (s: string) => string;
  diffHunk: (s: string) => string;
}

export const darkTheme: TuiTheme = {
  accent: (s) => pc.cyan(s),
  muted: (s) => pc.gray(s),
  error: (s) => pc.red(s),
  success: (s) => pc.green(s),
  warning: (s) => pc.yellow(s),
  user: (s) => pc.blue(s),
  assistant: (s) => s,
  system: (s) => pc.magenta(s),
  toolHeader: (s) => pc.bold(pc.cyan(s)),
  diffAdd: (s) => pc.green(s),
  diffDel: (s) => pc.red(s),
  diffCtx: (s) => pc.gray(s),
  diffHunk: (s) => pc.cyan(s),
};

export const lightTheme: TuiTheme = {
  accent: (s) => pc.cyan(s),
  muted: (s) => pc.gray(s),
  error: (s) => pc.red(s),
  success: (s) => pc.green(s),
  warning: (s) => pc.yellow(s),
  user: (s) => pc.blue(s),
  assistant: (s) => pc.black(s),
  system: (s) => pc.magenta(s),
  toolHeader: (s) => pc.bold(pc.cyan(s)),
  diffAdd: (s) => pc.green(s),
  diffDel: (s) => pc.red(s),
  diffCtx: (s) => pc.gray(s),
  diffHunk: (s) => pc.cyan(s),
};

/** The active theme. Selected by REAPER_TUI_THEME; defaults to dark. */
function pickTheme(): TuiTheme {
  const env = (process.env.REAPER_TUI_THEME ?? "dark").toLowerCase();
  if (env === "light") return lightTheme;
  return darkTheme;
}

export const theme: TuiTheme = pickTheme();