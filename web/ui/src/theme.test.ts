import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Imported through Vite rather than read with `node:fs`, because the jsdom
// environment installs its own `URL` and Node's `readFile` rejects a URL object
// that did not come from its own constructor.
import indexHtml from "../index.html?raw";

import { applyTheme, DEFAULT_THEME, readTheme, THEMES, writeTheme } from "./theme.js";

const BLACK = "data-ds-black-theme";
const REAPER = "data-ds-reaper-theme";
const DARK = "data-ds-dark-theme";

beforeEach(() => {
  window.localStorage.clear();
  document.body.removeAttribute(DARK);
  document.body.removeAttribute(BLACK);
  document.body.removeAttribute(REAPER);
});

afterEach(() => {
  window.localStorage.clear();
  document.body.removeAttribute(DARK);
  document.body.removeAttribute(BLACK);
  document.body.removeAttribute(REAPER);
});

describe("theme", () => {
  it("offers only dark-family themes", () => {
    // A light theme reappearing here would be a regression against the stated
    // requirement, not a harmless extra. Named rather than counted, so adding a
    // theme is a reviewed change to this list.
    expect([...THEMES].sort()).toEqual(["black", "dark", "reaper"]);
  });

  it("defaults to reaper when nothing is stored", () => {
    // Not `dark`. That is the vendored sheet's blue-accented palette, so
    // defaulting to it meant a fresh install showed DeepSeek's brand and the
    // Reaper theme was only reachable through Settings.
    expect(readTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("reaper");
  });

  it("ignores a stored value that is not a theme", () => {
    // A stale or hand-edited key must not put the body into a half-applied
    // state or throw during boot.
    window.localStorage.setItem("reaper.theme", "light");
    expect(readTheme()).toBe(DEFAULT_THEME);
    window.localStorage.setItem("reaper.theme", "");
    expect(readTheme()).toBe(DEFAULT_THEME);
  });

  it("keeps index.html's inline default in step with DEFAULT_THEME", () => {
    // The inline script runs before any module loads, so it cannot import this
    // constant and has to repeat the literal. That makes drift silent and
    // visible only as a flash of the wrong theme on first paint, which no other
    // test here would catch.
    expect(indexHtml).toContain(`var theme = "${DEFAULT_THEME}"`);
  });

  it("keeps data-ds-dark-theme set for black", () => {
    // Black is layered on top of the dark sheet rather than replacing it; if
    // this attribute were dropped, every alias token would fall back to the
    // light `:root` values and the UI would go white on dark surfaces.
    applyTheme("black");
    expect(document.body.hasAttribute(DARK)).toBe(true);
    expect(document.body.hasAttribute(BLACK)).toBe(true);
  });

  it("removes the black attribute when switching back", () => {
    // The attribute must be *removed*, not merely overwritten, or an empty
    // value would keep matching the `[data-ds-black-theme]` selector.
    applyTheme("black");
    applyTheme("dark");
    expect(document.body.hasAttribute(DARK)).toBe(true);
    expect(document.body.hasAttribute(BLACK)).toBe(false);
  });

  it("keeps the dark sheet under reaper, and clears the other accent", () => {
    applyTheme("reaper");
    expect(document.body.hasAttribute(DARK)).toBe(true);
    expect(document.body.hasAttribute(REAPER)).toBe(true);
    expect(document.body.hasAttribute(BLACK)).toBe(false);
  });

  it("switching between accent themes leaves exactly one applied", () => {
    // Both ramps override the same neutral-bluish tokens, so leaving both
    // attributes on would make the winner depend on stylesheet order rather
    // than on which theme the user picked.
    applyTheme("black");
    applyTheme("reaper");
    expect(document.body.hasAttribute(BLACK)).toBe(false);
    expect(document.body.hasAttribute(REAPER)).toBe(true);
    applyTheme("black");
    expect(document.body.hasAttribute(REAPER)).toBe(false);
    expect(document.body.hasAttribute(BLACK)).toBe(true);
  });

  it("round-trips every theme", () => {
    for (const theme of THEMES) {
      writeTheme(theme);
      expect(readTheme()).toBe(theme);
    }
  });

  it("round-trips a written theme", () => {
    writeTheme("black");
    expect(readTheme()).toBe("black");
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
  });
});
