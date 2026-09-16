/*
 * The browser half of scripts/ramp-audit.mts.
 *
 * Collects every distinct opaque background colour actually painted, with a
 * count and a sample selector, so a theme's surface ramp can be checked against
 * what is really on screen rather than against what the stylesheet says should
 * be. Plain JS and one expression; see scripts/sample-brand-probe.js for why.
 */
(() => {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const oklch = (R, G, B) => {
    const r = lin(R), g = lin(G), b = lin(B);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return [L, Math.hypot(A, Bb), (Math.atan2(Bb, A) * 180 / Math.PI + 360) % 360];
  };
  /*
   * Parse a computed background colour to 0-255 RGB plus alpha.
   *
   * Two syntaxes reach here and they do not share a scale. A `color-mix()` that
   * the browser cannot fold into rgb() serialises as `color(srgb 0.21 0.18 0.30)`,
   * whose components are 0-1; reading those as 0-255 rounds the accent tint on
   * the in-progress row to pure black and this probe then reported a black
   * surface that was not on screen. `color-mix` is used throughout the
   * transcript, so that misread was not an edge case.
   */
  const parse = (v) => {
    const n = (v.match(/[\d.]+/g) || []).map(Number);
    const rgb = v.startsWith("color(")
      ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] === undefined ? 1 : n[3]]
      : [n[0] || 0, n[1] || 0, n[2] || 0, n[3] === undefined ? 1 : n[3]];
    return rgb.map((c, i) => (i < 3 ? Math.max(0, Math.min(255, c || 0)) : c));
  };
  const buckets = {};
  let area = 0;
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 12) continue;
    const c = parse(getComputedStyle(el).backgroundColor);
    if (c[3] < 0.5) continue;
    /*
     * Keyed on rgba, not rgb. A scrim is `rgba(0, 0, 0, 0.62)` and buckets to
     * the same `#000000` as an opaque black surface, so keying on rgb merged
     * the two and reported the overlay as a surface in the theme ramp.
     */
    const hex = "#" + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
      + (c[3] < 1 ? "@" + c[3].toFixed(2) : "");
    if (!buckets[hex]) buckets[hex] = { n: 0, area: 0, sample: "" };
    buckets[hex].n++;
    buckets[hex].area += rect.width * rect.height;
    if (!buckets[hex].sample && typeof el.className === "string" && el.className.trim()) {
      buckets[hex].sample = el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    area += rect.width * rect.height;
  }
  const rows = Object.keys(buckets).map((hex) => {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    const c = oklch((n >> 16) & 255, (n >> 8) & 255, n & 255);
    return {
      hex: hex,
      n: buckets[hex].n,
      share: (buckets[hex].area / area) * 100,
      sample: buckets[hex].sample,
      L: c[0],
      C: c[1],
      H: c[2],
    };
  });
  rows.sort((a, b) => b.share - a.share);
  return rows.slice(0, 40);
})()
