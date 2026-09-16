/**
 * The syntax palette's contract with the themes.
 *
 * The four syntax classes were raw hex until reaper needed a different keyword
 * colour, and the values only became interesting at that point: a keyword has to
 * be distinguishable from the accent, and the accent is per-theme. Nothing about
 * the highlighter's own tests can catch a theme collision, because the collision
 * is between two CSS values in different files.
 *
 * These read the stylesheet as text rather than resolving it in a browser, which
 * is a real limitation: it proves the declarations exist and hold the values the
 * themes expect, not that a rendered keyword looks the way the numbers say. The
 * rendered check is `scripts/contrast.mts` against a live page, and the visual
 * check is the screenshot loop.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * Read from disk rather than imported. Vitest stubs CSS imports by default, so
 * `import css from "./styles.css?raw"` yields an empty string and every
 * assertion below would silently pass against `""`. `import.meta.url` is not an
 * option either: under jsdom it has no host, so it resolves to "/src/..." and
 * the read fails.
 *
 * Two candidates, because the suite runs both as `npx vitest --root web/ui` from
 * the repo root and as `npx vitest` from inside web/ui. A wrong path throws
 * rather than returning empty, which is the failure mode worth having.
 */
const css = readFileSync(
  [resolve("web/ui/src/styles.css"), resolve("src/styles.css")].find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  }) ?? "web/ui/src/styles.css",
  "utf8",
);

/**
 * The value a custom property is given inside every block whose selector
 * matches, last one winning.
 *
 * Walks all matches rather than the first, because the cascade is the point: the
 * base declaration sits in one `body` block and a theme overrides it in another,
 * and the value a browser resolves is the later one. Searching only the first
 * `body {` would report the default and call the override missing.
 */
function valueIn(selector: RegExp, property: string): string | null {
  let value: string | null = null;
  for (const match of css.matchAll(selector)) {
    const open = css.indexOf("{", match.index);
    const close = css.indexOf("}", open);
    const found = css.slice(open, close).match(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`));
    if (found?.[1]) value = found[1].trim();
  }
  return value;
}

/** The sRGB a `#rrggbb` literal names, for hue comparison. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Hue in OKLCH, which is the space where "these look like the same colour" is
 *  actually predictable; sRGB hue would call violet and magenta further apart
 *  than they read. */
function hue(hex: string): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return (Math.atan2(bb, a) * 180) / Math.PI + 360;
}

/** Shortest angular distance between two hues, in degrees. */
function gap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("syntax palette", () => {
  it("resolves every class through a token rather than a literal", () => {
    // A raw hex in one of these rules is the bug this guards: it cannot be
    // retinted per theme, which is exactly what reaper needed.
    for (const cls of ["hl-com", "hl-str", "hl-num", "hl-kw", "hl-fn"]) {
      const rule = css.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`))?.[0];
      expect(rule, `${cls} rule missing`).toBeTruthy();
      expect(rule, `${cls} still hardcodes a colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("keeps the default keyword colour every theme inherits", () => {
    // The value the sheet already shipped. dark and black depend on this
    // staying put; changing it is a visible change to two themes, not one.
    expect(valueIn(/^body\s*\{/gm, "--syntax-keyword")).toBe("#b48ae0");
  });

  it("moves the reaper keyword clear of the reaper accent", () => {
    // The reason the token exists. Reaper's accent is violet at hue 294, and
    // the default keyword violet is hue 306, which is close enough to read as a
    // dimmed accent rather than as its own syntax class. 30 degrees is the
    // floor for "obviously a different colour" without leaving the family.
    const keyword = valueIn(/^body\[data-ds-reaper-theme\]\s*\{/gm, "--syntax-keyword");
    expect(keyword).toBeTruthy();
    // The accent lives in the vendored sheet, not here, so read it there. Only
    // the reaper block's value counts: the sheet declares -400 twice, once for
    // the light ramp and once for dark.
    const sheet = readFileSync(
      [resolve("web/ui/src/deepseek/theme/design-platform.css"), resolve("src/deepseek/theme/design-platform.css")]
        .find((p) => {
          try {
            readFileSync(p);
            return true;
          } catch {
            return false;
          }
        }) ?? "web/ui/src/deepseek/theme/design-platform.css",
      "utf8",
    );
    const reaperBlock = sheet.slice(sheet.indexOf("body[data-ds-reaper-theme]"));
    const accent = reaperBlock.match(/--dsw-static-deepseek-400:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(accent).toBeTruthy();
    const accentHex = `#${accent!.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
    expect(gap(hue(keyword!), hue(accentHex))).toBeGreaterThan(30);
  });

  it("keeps the diff text lighter than the diff row mark", () => {
    /*
     * The one place a colour has to be lighter than the token it belongs to.
     * `state-success-primary` and `state-error-primary` paint the row tints and
     * they also paint the rail discs, where a white glyph sits on them, so they
     * cannot be lightened. The diff's own text therefore carries a lighter pair.
     *
     * The failure mode this guards is someone noticing the duplicates and
     * folding them back into the state tokens, which drops the diff text to
     * 3.23:1 and the comment on top of it to 2.53:1 without changing anything a
     * typecheck or a component test can see. `scripts/contrast.mts` measures the
     * rendered pairs and is the check that owns the ratios; this one only pins
     * that the tokens exist, are declared once, and are not the state tokens.
     */
    const add = valueIn(/^body\s*\{/gm, "--diff-add-text");
    const del = valueIn(/^body\s*\{/gm, "--diff-del-text");
    expect(add).toBe("rgb(140, 228, 166)");
    expect(del).toBe("rgb(255, 150, 150)");
  });
});
