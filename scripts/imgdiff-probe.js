/*
 * The browser half of scripts/imgdiff.mts. Plain JS and one expression; see
 * scripts/sample-brand-probe.js for why.
 */
({ a, b }) =>
  Promise.all([a, b].map((d) => {
    const i = new Image();
    i.src = "data:image/png;base64," + d;
    return i.decode().then(() => {
      const c = document.createElement("canvas");
      c.width = i.naturalWidth;
      c.height = i.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(i, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    });
  })).then((imgs) => {
    const A = imgs[0], B = imgs[1];
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < A.data.length; i += 4) {
      if (A.data[i] === B.data[i] && A.data[i + 1] === B.data[i + 1] && A.data[i + 2] === B.data[i + 2]) continue;
      n++;
      const px = (i / 4) % A.width;
      const py = Math.floor(i / 4 / A.width);
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    return { n: n, box: n ? [x0, y0, x1, y1] : null, w: A.width, h: A.height };
  });
