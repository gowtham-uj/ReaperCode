/**
 * Runtime wiring for the extension system. Three responsibilities:
 *
 *   1. `installExtensionTools(executor, registry)` — copy an
 *      ExtensionRegistry's tool records into the executor's
 *      ExtensionToolRegistry so the executor's unknown-tool guard
 *      accepts the names and the default dispatch routes them.
 *
 *   2. `createExecutorExtensionBridge(executor, registry)` — the
 *      full bridge: takes a fresh ExtensionRegistry and wires its
 *      tools into the executor, then activates every enabled
 *      extension. Returns a teardown function.
 *
 *   3. `createHookBridge(hooks, runner)` — thin re-export of the
 *      runtime/hook-bridge installer so callers can wire it from
 *      one place.
 *
 * The executor keeps its own `ExtensionToolRegistry` instance. The
 * ExtensionRegistry uses its own internally too; the wiring copies
 * tool records from the source into the executor's instance so the
 * executor never reaches back into the registry.
 */

import type { ToolExecutor } from "../tools/executor.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { ExtensionToolRegistry, type ExtensionToolHandler } from "../extensions/tool-registry.js";
import { installHookBridge } from "./hook-bridge.js";
import type { Hooks } from "../adaptive/hooks.js";
import { HookRunner } from "../extensions/hook-runner.js";

export interface WireOptions {
  executor: ToolExecutor;
  registry: ExtensionRegistry;
}

/**
 * Copy every enabled extension's tools into the executor's own registry.
 *
 * The executor's registry is a constructor option (`extensionTools`). It is not
 * created here and not patched onto the executor afterwards: an earlier version
 * of this function did exactly that, reading a field through a cast, and
 * because the field never existed the copy loop was skipped on every run while
 * every caller reported success. A missing registry is now an error the caller
 * sees, which is the only way a broken wiring step stays visible.
 *
 * Returns the count of tools installed.
 */
export function installExtensionTools(opts: WireOptions): number {
  /*
   * Copy enabled extensions' tools into the executor's own registry.
   *
   * This used to reach for `(executor as { extensionToolRegistry? })` — a field
   * `ToolExecutor` has never had. The cast defeated the type checker, produced
   * `undefined`, and the whole loop was skipped: `installed` stayed 0 on every
   * run while `enable` reported `activated: true` and the registry really did
   * hold the tool. The user's experience was an extension that created,
   * trusted, enabled and activated successfully, and a tool that could not be
   * called and did not appear in `tools.list()`.
   *
   * The registry is now a declared option, so the target is either present or
   * the wiring is being called wrong — and that case is reported rather than
   * silently doing nothing.
   */
  const target = opts.executor.getOptions().extensionTools;
  if (!target) {
    if (opts.registry.list().some((r) => r.status === "enabled")) {
      // Only a problem when there is something to install, so a run with no
      // extensions stays quiet instead of warning about a capability it is not
      // using.
      throw new Error(
        "installExtensionTools: the executor has no `extensionTools` registry, "
        + "so enabled extensions' tools cannot be dispatched. Pass one when constructing ToolExecutor.",
      );
    }
    return 0;
  }

  let installed = 0;
  for (const r of opts.registry.list()) {
    /*
     * Enabled, not "trusted". There are no trust tiers, and this filter — which
     * skipped anything `project-untrusted` — meant an extension from a project
     * directory had its tools dropped here even when it had activated. The
     * `disable` action still withholds tools, because switching something off is
     * a real intent rather than a trust judgement.
     */
    if (r.status !== "enabled" && r.status !== "installed") continue;
    const registry = opts.registry.getToolRegistry();
    for (const toolName of registry.listTools()) {
      const meta = registry.getMetadata(toolName);
      const def = registry.getDefinition(toolName);
      /*
       * A tool without metadata is dropped by the registry's own invariant, and
       * dropping it here silently is how a first-time author loses a tool with
       * no diagnostic. `enable` reports it instead — see the count check in the
       * caller — so this `continue` is the last quiet step, not the last step.
       */
      if (!meta || !def) continue;
      if (target.hasTool(toolName)) continue;
      const srcRecord = readRecord(registry, toolName);
      if (!srcRecord) continue;
      target.register({
        extensionId: r.id,
        definition: def,
        metadata: meta,
        handler: srcRecord.handler,
        grantedPermissions: r.manifest.permissions ?? [],
      });
      installed++;
    }
  }
  return installed;
}

/**
 * Read a tool record's handler, through the registry's own accessor.
 *
 * This used to index a private `records` map through a cast. It worked, but it
 * depended on a field name that no type checker would notice changing — the
 * same class of coupling that had already made `installExtensionTools` a silent
 * no-op. `getRecord` is the supported way to ask, and a rename now fails to
 * compile instead of failing at runtime in a way nothing reports.
 */
function readRecord(reg: ExtensionToolRegistry, name: string): { handler: ExtensionToolHandler } | null {
  const record = reg.getRecord(name);
  return record ? { handler: record.handler } : null;
}

/**
 * Activate every enabled extension and copy their tools into the
 * executor. Returns counts.
 */
export async function activateAndWire(opts: WireOptions): Promise<{ activated: number; failed: number; toolsInstalled: number }> {
  const { activated, failed } = await opts.registry.activateAll();
  const toolsInstalled = installExtensionTools(opts);
  return { activated, failed, toolsInstalled };
}

/**
 * Wire a fresh HookRunner into the existing Hooks instance so
 * extension handlers see events the engine emits. Returns the
 * bridge teardown.
 */
export function createHookBridge(opts: { hooks: Hooks; runner: HookRunner; bus?: ReturnType<typeof import("../extension/bus.js").getExtensionBus> | undefined }): () => void {
  return installHookBridge({
    hooks: opts.hooks,
    runner: opts.runner,
    useMicrotask: true,
    ...(opts.bus ? { bus: opts.bus } : {}),
  });
}

export { ExtensionToolRegistry };
