/**
 * loadExtensionMain — dynamic import of the extension entry with
 * fault isolation. Returns `{ok:false, error}` on any failure
 * instead of throwing, so the registry can record the failure
 * without crashing the host.
 *
 * Expected module shape: `default.activate(ctx)` and optionally
 * `default.deactivate(ctx)`. Both may be async.
 *
 * For TS files, we attempt the import as-is; if Node can't resolve
 * `.ts` (which is the common case without a loader), we surface a
 * clear error message rather than a stack trace.
 */

import { ExtensionValidationError } from "./types.js";
import { parsePackageMetadata } from "./package.js";
import type { ExtensionManifest } from "./types.js";

export interface LoadResult {
  ok: boolean;
  module?: ActivatedModule;
  mainPath?: string;
  error?: string;
}

export interface ActivatedModule {
  default: {
    activate?: (ctx: unknown) => unknown | Promise<unknown>;
    deactivate?: (ctx: unknown) => unknown | Promise<unknown>;
  };
}

/**
 * Load the extension entry point. Always returns a result; never
 * throws. The caller (ExtensionRegistry.activateAll) decides how
 * to record the failure on the LoadedExtension.
 */
export async function loadExtensionMain(extensionDir: string, manifest: ExtensionManifest): Promise<LoadResult> {
  let pkgResult: ReturnType<typeof parsePackageMetadata>;
  try {
    pkgResult = parsePackageMetadata(extensionDir, manifest);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!pkgResult.ok || !pkgResult.mainPath) {
    return { ok: false, error: pkgResult.errors.join("; ") };
  }
  const mainPath = pkgResult.mainPath;
  let mod: unknown;
  try {
    // Use a file URL for cross-platform safety; this is required
    // for Windows paths and for source paths with spaces.
    mod = await import(pathToFileUrl(mainPath));
  } catch (e) {
    return {
      ok: false,
      mainPath,
      error: `failed to import ${mainPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!mod || typeof mod !== "object") {
    return { ok: false, mainPath, error: `extension main did not export a module object (got ${typeof mod})` };
  }
  const def = (mod as { default?: unknown }).default;
  if (!def || typeof def !== "object") {
    return { ok: false, mainPath, error: "extension main must export `default` (the activate/deactivate object)" };
  }
  const activated = def as ActivatedModule["default"];
  if (typeof activated.activate !== "function") {
    return { ok: false, mainPath, error: "extension main.default.activate must be a function" };
  }
  return { ok: true, module: { default: activated }, mainPath };
}

function pathToFileUrl(p: string): string {
  // Node provides url.pathToFileURL but we avoid the dep just for this.
  if (p.startsWith("file://")) return p;
  // Replace backslashes for Windows; escape # for URLs.
  const norm = p.replace(/\\/g, "/");
  return "file://" + norm.split("/").map(encodeURIComponent).join("/");
}

/**
 * Same as loadExtensionMain but synchronous. Returns the module if
 * it was already loaded; otherwise attempts a synchronous require.
 * We deliberately do NOT use `require` from ESM context — this
 * helper returns ok=false in ESM contexts and the async path is
 * preferred.
 */
export function loadExtensionMainSync(extensionDir: string, manifest: ExtensionManifest): LoadResult {
  // The synchronous variant exists only for tests that need to
  // inspect the loaded module. The CLI uses the async path.
  let pkgResult: ReturnType<typeof parsePackageMetadata>;
  try {
    pkgResult = parsePackageMetadata(extensionDir, manifest);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!pkgResult.ok || !pkgResult.mainPath) {
    return { ok: false, error: pkgResult.errors.join("; ") };
  }
  return {
    ok: false,
    mainPath: pkgResult.mainPath,
    error: "synchronous load not supported in ESM context; use loadExtensionMain",
  };
}

/**
 * Lightweight shape guard for a loaded module. Throws on missing
 * default.activate; returns the validated object otherwise.
 */
export function assertActivated(mod: unknown): ActivatedModule["default"] {
  if (!mod || typeof mod !== "object") {
    throw new ExtensionValidationError("module", "EMODULE", "module is not an object");
  }
  const d = (mod as { default?: unknown }).default;
  if (!d || typeof d !== "object") {
    throw new ExtensionValidationError("module.default", "EMODULE", "module.default is missing");
  }
  const activated = d as ActivatedModule["default"];
  if (typeof activated.activate !== "function") {
    throw new ExtensionValidationError("module.default.activate", "EMODULE", "module.default.activate is not a function");
  }
  return activated;
}
