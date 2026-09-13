/**
 * The two themes Reaper ships.
 *
 * Both are dark-family: `body[data-ds-dark-theme]` carries the whole token set
 * from the DeepSeek sheet, and `black` layers a true-black surface ramp on top
 * of it. Keeping `data-ds-dark-theme` on both means a black theme inherits every
 * alias token rather than restating ~60 of them, so a token added to the dark
 * sheet can never be missing from black.
 *
 * This is a per-device display preference, not a user-global setting, so it
 * lives in localStorage rather than `~/.reaper/settings.json` — the same
 * account on a laptop and an OLED monitor wants different answers.
 */

export type Theme = "dark" | "black";

export const THEMES: readonly Theme[] = ["dark", "black"];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  black: "Black",
};

export const THEME_DESCRIPTIONS: Record<Theme, string> = {
  dark: "Deep grey surfaces with layered elevation.",
  black: "True black surfaces for OLED displays, with the same layering.",
};

const STORAGE_KEY = "reaper.theme";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "black";
}

/**
 * Storage is read directly rather than guarded by a module-level cache: the
 * inline `index.html` script that prevents a flash-of-wrong-theme writes the
 * same key from a different context, and a cache here would go stale behind it.
 *
 * Private-mode Safari throws on localStorage access, so every path is wrapped;
 * an unreadable preference degrades to the default instead of breaking boot.
 */
export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  const { body } = document;
  // Both themes are dark-family; `black` adds a second attribute rather than
  // replacing this one, so the dark token sheet stays active underneath.
  body.setAttribute("data-ds-dark-theme", "");
  if (theme === "black") body.setAttribute("data-ds-black-theme", "");
  else body.removeAttribute("data-ds-black-theme");
}

export function writeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
}
