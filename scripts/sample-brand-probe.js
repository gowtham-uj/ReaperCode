/*
 * The browser half of scripts/sample-brand.mts.
 *
 * Plain JS, and a single expression, on purpose. tsx injects esbuild's
 * `keepNames` helper into functions it transpiles and the page has no `__name`,
 * so a TypeScript arrow passed to page.evaluate throws `ReferenceError: __name
 * is not defined`. Read as text and wrapped in parentheses, this file never goes
 * through esbuild. It must also be one expression rather than a set of function
 * declarations, because the wrapper makes it a single parenthesised expression
 * and two declarations in a row are a syntax error there.
 */
({ src }) => {
  const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const oklch = (R, G, B) => {
    const r = toLin(R), g = toLin(G), b = toLin(B);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return [L, Math.hypot(A, Bb), (Math.atan2(Bb, A) * 180 / Math.PI + 360) % 360];
  };
  const img = new Image();
  img.src = src;
  return img.decode().then(() => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Only pixels that actually carry colour: a grey pixel's hue is noise.
    const coloured = [];
    for (let i = 0; i < d.length; i += 4) {
      const c = oklch(d[i], d[i + 1], d[i + 2]);
      if (c[1] > 0.03) coloured.push(c);
    }
    coloured.sort((a, b) => b[1] - a[1]);
    const band = coloured.slice(0, Math.max(1, Math.floor(coloured.length * 0.02)));
    const mean = (f) => band.reduce((s, c) => s + f(c), 0) / band.length;
    // Histogram hue over every coloured pixel, to check for a second hue family.
    const hist = new Array(36).fill(0);
    for (const c of coloured) hist[Math.floor(c[2] / 10) % 36]++;
    return {
      colouredPct: (coloured.length / (d.length / 4)) * 100,
      topChromaMean: mean((c) => c[1]),
      topChromaMax: coloured[0][1],
      topHueMean: mean((c) => c[2]),
      topHueMin: band[band.length - 1][2],
      topHueMax: band[0][2],
      topLMean: mean((c) => c[0]),
      topLMin: Math.min.apply(null, band.map((c) => c[0])),
      topLMax: Math.max.apply(null, band.map((c) => c[0])),
      hueHist: hist.map((n, i) => [i * 10, Math.round((n / coloured.length) * 1000) / 10]).filter((h) => h[1] >= 0.5),
    };
  });
}
