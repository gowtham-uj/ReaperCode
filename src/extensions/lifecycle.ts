/**
 * ExtensionLifecycle — the validate hook + reload surface for
 * model-callable extension authoring.
 *
 * Most extension lifecycle methods already live on `ExtensionRegistry`
 * (install, enable, trust_, uninstall, activateAll). This module
 * adds the small pieces the model-callable tools need:
 *
 *   - `validate(id)` — runs `manifest.validation.commands` and
 *     returns per-command results, without activating the extension.
 *   - `reload()` — re-walks the install dirs and rebuilds the
 *     in-memory registry. Used by the `reload_extensions` tool after
 *     the user hand-edits a folder.
 *
 * Trust gate: `validate` does not gate. `enable` + `trust_` are
 * already gated by the model-callable surface (which routes through
 * `ApprovalRequester`).
 */

import { spawnSync } from "node:child_process";
import { ExtensionRegistry } from "./registry.js";
import type { ExtensionManifest } from "./types.js";

export interface ValidateResult {
  ok: boolean;
  id: string;
  results: Array<{ id: string; exitCode: number; stdout: string; stderr: string }>;
  error?: string;
  /**
   * A non-failure remark, such as "there was nothing to validate". Distinct
   * from `error`: an extension with no validation commands is valid, and the
   * caller should not read it as broken.
   */
  note?: string;
}

export class ExtensionLifecycle {
  private readonly registry: ExtensionRegistry;

  constructor(registry: ExtensionRegistry) {
    this.registry = registry;
  }

  /**
   * Run `manifest.validation.commands[]` for the given extension.
   * Returns per-command results and fails-fast on the first non-zero.
   *
   * Does NOT activate the extension. The extension stays dormant
   * until the model calls `enable_extension` + `trust_extension`.
   *
   * Note: the current ExtensionManifest schema does not expose a
   * `validation.commands` block (this is a forward-looking hook).
   * When present on a custom manifest, the lifecycle honors it;
   * otherwise this is a no-op that reports the extension's
   * install-time error (if any).
   */
  validate(id: string): ValidateResult {
    const loaded = this.registry.get(id);
    if (!loaded) {
      return { ok: false, id, results: [], error: `extension "${id}" not found` };
    }
    const extManifest = loaded.manifest as ExtensionManifest & {
      validation?: { commands?: Array<{ id: string; command: string }> };
    };
    const cmds = extManifest.validation?.commands ?? [];
    if (cmds.length === 0) {
      /*
       * Nothing to validate is not a failed validation.
       *
       * The load error is the only thing that can make this a failure. A
       * healthy extension with no `validation.commands` block has nothing
       * wrong with it, and reporting `ok: false` for it read as "the extension
       * is invalid" — the audit observed exactly that on a freshly created,
       * perfectly valid extension. `ok: true` with an empty result list and a
       * note is the honest answer: the call did what it could, which was
       * nothing, and said so.
       */
      if (loaded.error) {
        return { ok: false, id, results: [], error: `extension "${id}" failed to load: ${loaded.error}` };
      }
      return {
        ok: true,
        id,
        results: [],
        note: `extension "${id}" declares no validation commands, so there was nothing to run; this is not a failure`,
      };
    }
    /*
     * `stdout` is captured as well as `stderr`.
     *
     * A validation command usually reports through stdout — a test runner's
     * summary, a `printf` marker — and the first version kept only stderr, so a
     * command that exited 0 with a printed result was returned as
     * `{ id, exitCode: 0, stderr: "" }` and its output was lost. The audit hit
     * this with a `printf` that printed a marker to stdout and got nothing back.
     */
    const results: Array<{ id: string; exitCode: number; stdout: string; stderr: string }> = [];
    for (const c of cmds) {
      const r = spawnSync(c.command, { shell: true, encoding: "utf8" });
      results.push({
        id: c.id,
        exitCode: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      });
      if (r.status !== 0) {
        return {
          ok: false,
          id,
          results,
          error: `validation command "${c.id}" failed with exit ${r.status ?? -1}`,
        };
      }
    }
    return { ok: true, id, results };
  }

  /**
   * Re-walk the install dirs and rebuild the in-memory registry.
   * Returns counts of loaded + registered extensions.
   */
  reload(): { loaded: number } {
    const found = this.registry.discover();
    return { loaded: found.length };
  }

  /** Get the underlying registry (for callers that need it). */
  getRegistry(): ExtensionRegistry {
    return this.registry;
  }
}
