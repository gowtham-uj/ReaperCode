/**
 * PostCSS, for the one stylesheet Tailwind builds.
 *
 * `tailwindcss` expands the `@tailwind utilities` directive in
 * `src/markdown-tailwind.css` into the scoped utility classes Streamdown needs.
 * `autoprefixer` is not included: Vite already prefixes through esbuild's
 * target, and a second prefixer would only duplicate work.
 *
 * Scoped by file rather than applied to the whole stylesheet set: Vite runs
 * PostCSS per file, and `styles.css` has no `@tailwind` directive, so Tailwind's
 * plugin passes it through untouched.
 *
 * The config path is named explicitly, and that is the whole fix for a real bug.
 * With a bare `tailwindcss: {}`, Tailwind resolves `tailwind.config.js` from the
 * process working directory. The UI is started from the repo root
 * (`vite --config web/ui/vite.config.ts`), where no such file exists, so the
 * config in this directory was never read. Tailwind fell back to an empty config
 * and emitted none of the utilities Streamdown names, because the `content` globs
 * and the `important: ".markdown"` scope both live in that file.
 *
 * What that looked like: a table taller than Streamdown's 300px `max-height` kept
 * its intrinsic height, because the `overflow-y-auto` class that would have
 * clipped it was not emitted. So the rows painted over the paragraph below and
 * over the composer. Measured in the running dev server:
 *
 *   curl -s 127.0.0.1:5273/src/markdown-tailwind.css | grep -c '\.markdown \.flex'
 *   before: 0    after: 37
 *
 * `fileURLToPath` is the same form `tailwind.config.js` already uses for its
 * `content` globs, and for the same reason: a path relative to this file is the
 * only one that is right whatever directory the build runs from.
 */
import { fileURLToPath } from "node:url";

export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) },
  },
};
