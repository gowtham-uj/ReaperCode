/*
 * Find the brand mark's own geometry inside the source artwork.
 *
 * The crop is unreadable at 16-32px because it keeps the whole illustration:
 * a halo, a planet limb, filigree, and a starfield all competing in a 16px
 * square. The halo is the one element that survives the size, so the icon has
 * to be rebuilt around it. This measures where it actually is, rather than
 * estimating from a screenshot.
 *
 * Reports the weighted centroid and the radius band of the brightest violet
 * ring, plus the bounding box of the bright vertical bar through it.
 */
({ src, size }) => {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => {
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size).data;
    const at = (x, y) => {
      const i = (y * size + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    /*
     * "Lit" means bright and violet-leaning. A plain luminance threshold picks
     * up the white blade too, and the blade is off-centre, so the two have to
     * be separated by hue rather than by brightness alone.
     */
    let sx = 0, sy = 0, n = 0;
    const samples = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, gg, b] = at(x, y);
        const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        if (lum < 150) continue;
        if (!(b > r && r > gg)) continue; // violet, not white
        sx += x; sy += y; n++;
        samples.push([x, y]);
      }
    }
    if (n === 0) return { found: false };
    const cx = sx / n, cy = sy / n;
    const radii = samples.map(([x, y]) => Math.hypot(x - cx, y - cy)).sort((a, b) => a - b);
    return {
      found: true,
      centroid: [Math.round(cx), Math.round(cy)],
      litPixels: n,
      radiusP05: radii[Math.floor(radii.length * 0.05)],
      radiusP50: radii[Math.floor(radii.length * 0.5)],
      radiusP95: radii[Math.floor(radii.length * 0.95)],
      radiusMax: radii[radii.length - 1],
      // Fractions of the frame, which is what a rebuild needs.
      centroidPct: [cx / size, cy / size],
      radiusP50Pct: radii[Math.floor(radii.length * 0.5)] / size,
    };
  });
}
