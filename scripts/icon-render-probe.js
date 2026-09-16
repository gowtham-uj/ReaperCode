/*
 * Draw the Reaper mark from the artwork's own measured geometry.
 *
 * The committed icon was a crop of the whole illustration, and at 16-32px that
 * is an unreadable smudge: a halo, a planet limb, filigree and a starfield all
 * inside one small square. What survives that size is the halo, so the mark is
 * rebuilt around it using the numbers `icon-probe.js` measured rather than a
 * designer's guess, on the same near-black ground and violet the theme uses.
 *
 * Drawn at 512 and downsampled by the browser, because a ring drawn directly at
 * 16px aliases into a dotted circle.
 */
({ size }) => {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const g = c.getContext("2d");

  // Sampled from the theme's own ramp: bg-base, the accent, and the glow core.
  const GROUND = "#020108";
  const ACCENT = "rgb(150, 106, 250)";
  const GLOW = "rgb(209, 200, 246)";
  const DEEP = "rgb(57, 24, 112)";

  g.fillStyle = GROUND;
  g.fillRect(0, 0, size, size);

  const cx = size * 0.5;
  const cy = size * 0.5;
  // The measured halo: 50th-percentile radius is 34.5% of the frame, and the
  // ring's band sits either side of it.
  const ringOuter = size * 0.345;
  const ringWidth = size * 0.075;

  // A soft violet bloom behind the ring, which is what makes the mark read as
  // lit rather than as a flat outline at small sizes.
  const bloom = g.createRadialGradient(cx, cy, ringOuter * 0.2, cx, cy, size * 0.5);
  bloom.addColorStop(0, "rgba(150, 106, 250, 0.55)");
  bloom.addColorStop(0.55, "rgba(57, 24, 112, 0.35)");
  bloom.addColorStop(1, "rgba(2, 1, 8, 0)");
  g.fillStyle = bloom;
  g.fillRect(0, 0, size, size);

  // The ring itself, with a darker inner edge so it has depth.
  g.beginPath();
  g.arc(cx, cy, ringOuter, 0, Math.PI * 2);
  g.strokeStyle = DEEP;
  g.lineWidth = ringWidth * 1.5;
  g.stroke();

  g.beginPath();
  g.arc(cx, cy, ringOuter, 0, Math.PI * 2);
  g.strokeStyle = ACCENT;
  g.lineWidth = ringWidth;
  g.stroke();

  /*
   * The vertical bar. In the artwork it is the brightest thing in the frame and
   * it is what makes the composition read as a scythe-staff rather than as a
   * plain circle; at 16px it is the only interior detail that survives, so it
   * stays and everything else goes.
   */
  const barWidth = Math.max(2, size * 0.045);
  const barTop = cy - ringOuter * 1.16;
  const barBottom = cy + ringOuter * 1.16;
  const bar = g.createLinearGradient(0, barTop, 0, barBottom);
  bar.addColorStop(0, GLOW);
  bar.addColorStop(0.5, ACCENT);
  bar.addColorStop(1, GLOW);
  g.fillStyle = bar;
  g.beginPath();
  if (g.roundRect) g.roundRect(cx - barWidth / 2, barTop, barWidth, barBottom - barTop, barWidth / 2);
  else g.rect(cx - barWidth / 2, barTop, barWidth, barBottom - barTop);
  g.fill();

  // The hot core where the bar crosses the ring, which is the image's focal
  // point and the thing the eye lands on first.
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, ringOuter * 0.62);
  core.addColorStop(0, "rgba(250, 244, 254, 0.95)");
  core.addColorStop(0.38, "rgba(196, 156, 238, 0.5)");
  core.addColorStop(1, "rgba(150, 106, 250, 0)");
  g.fillStyle = core;
  g.fillRect(0, 0, size, size);

  return c.toDataURL("image/png").split(",")[1];
}
