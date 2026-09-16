/**
 * The browser half of scripts/contrast.mts.
 *
 * A separate plain-JS file rather than an inline function, for two reasons that
 * both bit: tsx compiles with esbuild's keepNames, which wraps every function in
 * a `__name()` call the page has never heard of, and passing the code as a
 * template literal instead means Node interpolates every `${}` before the page
 * ever sees it. Reading a file is the one approach with neither problem.
 *
 * Walks every element that owns a text node, composites it against the first
 * opaque ancestor background, and returns the WCAG ratio with the threshold that
 * applies at that element's own size.
 */
(() => {
  /*
   * Parse a computed colour to 0-255 RGB plus alpha, in either syntax.
   *
   * `color-mix()` results that the browser cannot fold into rgb() serialise as
   * `color(srgb 0.21 0.18 0.30)`, with components on a 0-1 scale. Reading those
   * as 0-255 rounded every one of them to black, and the transcript uses
   * color-mix for the in-progress row, the running badge and the diff tints, so
   * this audit was measuring those against black instead of against their real
   * backgrounds. It reported zero failures while the accent text on the tinted
   * in-progress row measured 3.51:1.
   */
  const parse = (value) => {
    const nums = (value.match(/[\d.]+/g) || []).map(Number);
    const rgb = value.startsWith("color(")
      ? [nums[0] * 255, nums[1] * 255, nums[2] * 255, nums[3] === undefined ? 1 : nums[3]]
      : [nums[0] || 0, nums[1] || 0, nums[2] || 0, nums[3] === undefined ? 1 : nums[3]];
    return rgb.map((c, i) => (i < 3 ? Math.max(0, Math.min(255, c || 0)) : c));
  };
  const lum = (c) => {
    const f = (v) => {
      const s = (v || 0) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const over = (fg, bg) => {
    const a = fg[3] === undefined ? 1 : fg[3];
    return [0, 1, 2].map((i) => (fg[i] || 0) * a + (bg[i] || 0) * (1 - a));
  };

  const out = [];
  const seen = {};

  const all = document.querySelectorAll("*");
  for (let n = 0; n < all.length; n++) {
    const el = all[n];
    let hasText = false;
    for (let k = 0; k < el.childNodes.length; k++) {
      const node = el.childNodes[k];
      if (node.nodeType === 3 && (node.textContent || "").trim().length > 0) { hasText = true; break; }
    }
    if (!hasText) continue;

    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;

    /*
     * Skip text that is not on screen.
     *
     * `sr-only` is clipped to a 1px box and exists for screen readers, so its
     * colour pair is not a contrast question — it reported the accent at 4.13:1
     * against a surface nobody can see it on. Filtering here rather than
     * recolouring it, because changing an invisible colour to satisfy a
     * measurement is work done for the measurement.
     */
    if (el.closest(".sr-only") !== null) continue;

    /*
     * Composite the whole background stack, nearest layer last.
     *
     * The previous version walked up and, on reaching the first opaque
     * ancestor, replaced everything it had accumulated with that colour. That
     * discarded the element's own translucent background, so a badge tinted
     * `color-mix(red 14%, transparent)` was measured against the bare card
     * instead of against its own tint — 4.59:1 reported where 3.86:1 is what
     * shows, and the failure it was meant to catch went unreported.
     */
    const layers = [];
    let base = [0, 0, 0];
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c[3] > 0.98) { base = c.slice(0, 3); break; }
      if (c[3] > 0) layers.push(c);
    }
    let bg = base;
    for (let i = layers.length - 1; i >= 0; i--) {
      const a = layers[i][3];
      bg = [0, 1, 2].map((k) => layers[i][k] * a + bg[k] * (1 - a));
    }
    /*
     * Folding an element's `opacity` into its text and background, because it
     * scales both and the ratio is what survives. `.diff-num` sets `opacity:
     * .75` and the line-number grey composites with the row's tint, so the
     * un-adjusted measurement was off by a factor of two: 4.27:1 reported where
     * the painted result is 1.97:1.
     *
     * This walks ancestors and multiplies, so a group fade counts too. It does
     * not model blending modes or filters, which nothing in this sheet uses.
     */
    let opacity = 1;
    for (let node = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
      if (opacity === 0) break;
    }
    // Fully transparent text is not painted, so it has no ratio to fail.
    // `.tool-raw-summary` is `opacity: 0` until hover or focus and measured
    // 1.00:1 here, which is what "invisible" looks like as a number.
    if (opacity === 0) continue;
    const fg = over(parse(cs.color).slice(0, 3).concat([opacity]), bg);
    const pair = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = (pair[0] + 0.05) / (pair[1] + 0.05);
    // WCAG "large" is 18.66px bold or 24px regular; everything else is 4.5:1.
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;

    const cls = typeof el.className === "string" ? el.className.trim() : "";
    const sel = cls ? el.tagName.toLowerCase() + "." + cls.split(/\s+/).join(".") : el.tagName.toLowerCase();
    /*
     * Dedup on the resolved colours as well as the selector.
     *
     * Keying on selector and size alone meant one instance per class was
     * measured, and which instance came first in document order decided it. The
     * in-progress tool row is the same markup as a completed one with different
     * colours and a tinted background, so the completed row claimed the key and
     * the accent-on-tint variant was never checked — which is how this audit
     * reported zero failures while that text measured 3.51:1.
     */
    const key = sel + "|" + Math.round(size) + "|" + fg.map(Math.round).join(",") + "|" + bg.slice(0, 3).map(Math.round).join(",");
    if (seen[key]) continue;
    seen[key] = true;

    out.push({
      sel: sel,
      size: size,
      ratio: Math.round(ratio * 100) / 100,
      need: need,
      fg: "rgb(" + fg.map(Math.round).join(",") + ")",
      bg: "rgb(" + bg.slice(0, 3).map(Math.round).join(",") + ")",
    });
  }
  return out;
})()
