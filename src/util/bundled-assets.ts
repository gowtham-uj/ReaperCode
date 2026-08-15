/**
 * Bundled (single-file) asset access.
 *
 * The single-file `reaper.mjs` bundle inlines the on-disk resources that the
 * CLI reads at runtime — the built-in skills and the linter manifest — as
 * compile-time constants injected by esbuild `--define` (see
 * `scripts/build-bundle.mjs`). Outside the bundle (source/dev/test) these
 * identifiers are undefined, so the normal `import.meta.url`-relative paths
 * keep working unchanged.
 *
 * `typeof` guards make the identifiers safe to reference when they are not
 * defined at all (the source/dev case).
 */

declare const __REAPER_BUNDLED_SKILLS__: Record<string, string> | undefined;
declare const __REAPER_BUNDLED_LINTERS__: string | undefined;

/** Built-in skills manifest (relpath → file contents), only present in the bundle. */
export function bundledSkills(): Record<string, string> | undefined {
  return typeof __REAPER_BUNDLED_SKILLS__ !== "undefined" ? __REAPER_BUNDLED_SKILLS__ : undefined;
}

/** Linter `manifest.json` contents, only present in the bundle. */
export function bundledLinterManifest(): string | undefined {
  return typeof __REAPER_BUNDLED_LINTERS__ !== "undefined" ? __REAPER_BUNDLED_LINTERS__ : undefined;
}
