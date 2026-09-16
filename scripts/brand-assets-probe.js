/*
 * Fit the whole brand image into a frame, losing nothing.
 *
 * The requirement is explicit: resize, do not crop, do not lose the content of
 * the brand image. So this is a contain fit, never a cover fit. The artwork is
 * 941x1672 portrait, and a square icon built by cropping it throws away most of
 * the composition, so the entire image is scaled down to fit and the space
 * either side is filled with a blown-up, blurred copy of the image itself.
 *
 * The blurred backdrop is the whole trick. The alternatives are worse: padding
 * with the theme's near-black makes the artwork look like a mistake in a
 * letterbox, and stretching it to the square distorts the scythe. A blurred
 * copy of the same pixels means the edges of the sharp copy blend into a
 * continuation of its own colours, so the frame reads as one image rather than
 * as an image on a background.
 *
 * `mode` picks the layout:
 *   "contain"  the whole image, sharp and centred, over the blurred field.
 *   "wide"     a README banner: the whole image at full canvas height, held
 *              off to one side, with the blurred field filling the rest.
 *   "card"     a social preview: the image centred at a fraction of the frame,
 *              with generous blurred margins, so text can sit under it.
 */
({ src, width, height, mode, blur, dim }) => {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");

    /*
     * The backdrop: the same image scaled to *cover* the canvas, then blurred.
     * Cover rather than contain so it reaches every edge; a contained backdrop
     * would leave the same empty margins it is there to remove.
     *
     * Zoomed past cover on purpose. The artwork's light is concentrated in the
     * middle third, so a plain cover fit puts mostly-black sky in the side
     * margins and the tile reads as a picture floating in a dark box. Scaling
     * up means the blurred field is carrying the scythe's own violet, which is
     * what makes the edges of the sharp copy blend into it.
     */
    const coverScale = Math.max(width / img.naturalWidth, height / img.naturalHeight) * 1.6;
    const coverW = img.naturalWidth * coverScale;
    const coverH = img.naturalHeight * coverScale;
    g.save();
    g.filter = "blur(" + blur + "px)";
    g.drawImage(img, (width - coverW) / 2, (height - coverH) / 2, coverW, coverH);
    g.restore();

    /*
     * Lifted, not darkened. The artwork is already near-black, so a scrim over
     * it leaves a small icon indistinguishable from an empty tile: measured at
     * 0.55 the 16px render had no visible content at all. `screen` keeps the
     * violet and lifts the blacks, and the low-alpha ground keeps it from
     * washing out into flat grey.
     */
    g.globalCompositeOperation = "screen";
    g.fillStyle = "rgba(46, 22, 84, " + (1 - dim) * 0.55 + ")";
    g.fillRect(0, 0, width, height);
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "rgba(2, 1, 8, " + dim * 0.35 + ")";
    g.fillRect(0, 0, width, height);

    /*
     * The sharp copy, contained in every mode: the whole image, nothing cut.
     * Never upscaled past the frame in either axis.
     */
    const scale = mode === "card"
      ? Math.min(width * 0.62 / img.naturalWidth, height * 0.62 / img.naturalHeight)
      : Math.min(width / img.naturalWidth, height / img.naturalHeight);
    const sharpW = img.naturalWidth * scale;
    const sharpH = img.naturalHeight * scale;
    /* On the wide banner the mark is held to the left so a headline has the
       right two thirds to itself; everywhere else it is centred. */
    const x = mode === "wide" ? width * 0.07 : (width - sharpW) / 2;
    const y = mode === "card" ? (height - sharpH) / 2 - height * 0.02 : (height - sharpH) / 2;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, x, y, sharpW, sharpH);

    return c.toDataURL("image/png").split(",")[1];
  });
}
