import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyTheme, readTheme, THEMES, writeTheme } from "./theme.js";

const BLACK = "data-ds-black-theme";
const DARK = "data-ds-dark-theme";

beforeEach(() => {
  window.localStorage.clear();
  document.body.removeAttribute(DARK);
  document.body.removeAttribute(BLACK);
});

afterEach(() => {
  window.localStorage.clear();
  document.body.removeAttribute(DARK);
  document.body.removeAttribute(BLACK);
});

describe("theme", () => {
  it("offers only dark-family themes", () => {
    // The product shows dark and black; a light theme reappearing here would be
    // a regression against the stated requirement, not a harmless extra.
    expect([...THEMES].sort()).toEqual(["black", "dark"]);
  });

  it("defaults to dark when nothing is stored", () => {
    expect(readTheme()).toBe("dark");
  });

  it("ignores a stored value that is not a theme", () => {
    // A stale or hand-edited key must not put the body into a half-applied
    // state or throw during boot.
    window.localStorage.setItem("reaper.theme", "light");
    expect(readTheme()).toBe("dark");
    window.localStorage.setItem("reaper.theme", "");
    expect(readTheme()).toBe("dark");
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

  it("round-trips a written theme", () => {
    writeTheme("black");
    expect(readTheme()).toBe("black");
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
  });
});
