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
import { pathToFileURL } from "node:url";

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
    mod = await import(pathToFileURL(mainPath).href);
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
  const activated = resolveActivation(mod as Record<string, unknown>);
  if (!activated) {
    return {
      ok: false,
      mainPath,
      error:
        "extension main must export an object with an `activate` function — "
        + "either `module.exports = { activate, deactivate }` or "
        + "`module.exports = { default: { activate, deactivate } }`",
    };
  }
  return { ok: true, module: { default: activated }, mainPath };
}

/**
 * Find the activate/deactivate pair in a loaded entry point, whatever shape the
 * author used.
 *
 * `await import()` of a CommonJS module does not hand back `module.exports` as
 * `mod`; it hands back a namespace whose `default` *is* `module.exports`. So an
 * author who writes the documented shape —
 * `module.exports = { default: { activate } }` — is read as
 * `mod.default.default.activate`, and the loader's `mod.default.activate` is
 * `undefined`. The diagnostic was reported as "extension main.default.activate
 * must be a function" for every export shape an author could reasonably try,
 * because each one put the real function one level below where it was looked
 * for.
 *
 * Measured against the file the loader reads:
 *
 *   typeof mod.default                       -> "object"
 *   mod.default.activate                     -> undefined     (what it checked)
 *   mod.default.default.activate             -> function      (where it lived)
 *
 * Two shapes are accepted rather than one, because both are legitimate: the
 * documented `{ default: {...} }` and the more natural
 * `module.exports = { activate, deactivate }`, which the loader's own error
 * message had been (incorrectly) implying was wrong. Unwrapping is bounded to
 * two levels — deep enough for the CJS double-wrap, shallow enough that a
 * genuinely malformed module is still refused rather than searched.
 */
function resolveActivation(mod: Record<string, unknown>): ActivatedModule["default"] | undefined {
  /*
   * A bare function export is accepted as the activation itself.
   *
   * `module.exports = async function activate() {}` is a shape an author
   * reaches for, and it is unambiguous: there is exactly one thing exported and
   * it is callable. Rejecting it would be pedantry about a wrapper that carries
   * no information. `deactivate` is simply absent, which the interface already
   * allows.
   */
  const asFunction = (value: unknown): ActivatedModule["default"] | undefined =>
    typeof value === "function"
      ? { activate: value as (ctx: unknown) => unknown }
      : undefined;

  const candidates = [
    mod.default,
    mod,
    (mod.default as Record<string, unknown> | undefined)?.default,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && typeof (candidate as { activate?: unknown }).activate === "function") {
      return candidate as ActivatedModule["default"];
    }
    const fn = asFunction(candidate);
    if (fn) return fn;
  }
  return undefined;
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
