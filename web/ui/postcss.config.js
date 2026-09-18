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
 */
export default {
  plugins: {
    tailwindcss: {},
  },
};
