/**
 * The three themes Reaper ships.
 *
 * All are dark-family: `body[data-ds-dark-theme]` carries the whole token set
 * from the DeepSeek sheet, and `black` and `reaper` each layer their own surface
 * ramp on top of it. Keeping `data-ds-dark-theme` on all three means they
 * inherit every alias token rather than restating ~60 of them, so a token added
 * to the dark sheet can never be missing from one of these.
 *
 * This is a per-device display preference, not a user-global setting, so it
 * lives in localStorage rather than `~/.reaper/settings.json` — the same
 * account on a laptop and an OLED monitor wants different answers.
 */

export type Theme = "dark" | "black" | "reaper";

export const THEMES: readonly Theme[] = ["dark", "black", "reaper"];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  black: "Black",
  reaper: "Reaper",
};

export const THEME_DESCRIPTIONS: Record<Theme, string> = {
  dark: "Deep grey surfaces with layered elevation.",
  black: "True black surfaces for OLED displays, with the same layering.",
  reaper: "Near-black with a violet cast, from the Reaper mark.",
};

const STORAGE_KEY = "reaper.theme";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "black" || value === "reaper";
}

/**
 * What a browser with no stored preference gets.
 *
 * Not `dark`. That is the vendored sheet's own default and carries a blue
 * accent, so a fresh install showed DeepSeek's brand rather than this one and
 * the Reaper palette was only ever seen by someone who went looking in
 * Settings. The default is the theme the product is named after.
 */
export const DEFAULT_THEME: Theme = "reaper";

/**
 * Storage is read directly rather than guarded by a module-level cache: the
 * inline `index.html` script that prevents a flash-of-wrong-theme writes the
 * same key from a different context, and a cache here would go stale behind it.
 *
 * Private-mode Safari throws on localStorage access, so every path is wrapped;
 * an unreadable preference degrades to the default instead of breaking boot.
 * `DEFAULT_THEME` is a valid theme, so the same constant serves both paths
 * rather than a second literal that could drift from this one.
 */
export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  const { body } = document;
  // All themes are dark-family; each accent theme adds a second attribute
  // rather than replacing this one, so the dark token sheet stays active
  // underneath. Clearing the other attribute matters as much as setting this
  // one: without it, switching from `black` to `reaper` would leave both ramps
  // applied and the winner would come down to stylesheet order.
  body.setAttribute("data-ds-dark-theme", "");
  const accent = { black: "data-ds-black-theme", reaper: "data-ds-reaper-theme" } as const;
  for (const [name, attribute] of Object.entries(accent)) {
    if (theme === name) body.setAttribute(attribute, "");
    else body.removeAttribute(attribute);
  }
}

export function writeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
}
