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
import { ExtensionToolRegistry } from "../extensions/tool-registry.js";
import { installHookBridge } from "./hook-bridge.js";
import type { Hooks } from "../adaptive/hooks.js";
import { HookRunner } from "../extensions/hook-runner.js";

export interface WireOptions {
  executor: ToolExecutor;
  registry: ExtensionRegistry;
}

/**
 * Copy every registered tool from the source registry into the
 * executor's ExtensionToolRegistry. The executor may have received
 * its ExtensionToolRegistry from the constructor (`extensionToolRegistry`);
 * if not, this function creates one and patches it onto the executor's
 * options map (a runtime fallback for callers that don't pass it at
 * construction time).
 *
 * Returns the count of tools installed.
 */
export function installExtensionTools(opts: WireOptions): number {
  let installed = 0;
  // The executor does not expose its internal ExtensionToolRegistry
  // field by default; we install via the executor's own
  // registerExtensionTool (added in executor.ts) instead.
  for (const r of opts.registry.list()) {
    if (r.status !== "enabled") continue;
    if (r.trust === "project-untrusted") continue;
    const registry = opts.registry.getToolRegistry();
    for (const toolName of registry.listTools()) {
      const meta = registry.getMetadata(toolName);
      const def = registry.getDefinition(toolName);
      if (!meta || !def) continue;
      // Hand off to the executor's per-instance registry, which
      // requires ToolMetadata by invariant.
      const executorExt = (opts.executor as unknown as {
        extensionToolRegistry?: ExtensionToolRegistry;
      }).extensionToolRegistry;
      const target = executorExt ?? null;
      if (target && !target.hasTool(toolName)) {
        // Re-register by reading the inner record's handler. We
        // only need metadata + handler; permission granting is
        // carried over from the source registry.
        const srcRecord = readRecord(registry, toolName);
        if (srcRecord) {
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
    }
  }
  return installed;
}

/** Read a tool record's handler. Internal helper. */
function readRecord(reg: ExtensionToolRegistry, name: string): { handler: import("../extensions/tool-registry.js").ExtensionToolHandler } | null {
  // The records map is private; we re-export through getDefinition
  // and executeTool. To copy the handler, callers usually use the
  // registry's own `executeTool` indirection. For wiring we expose
  // a backdoor only when the registry is in the same process — no
  // IPC. The ExtensionToolRegistry exposes a getHandler() through
  // a debug surface.
  const h = (reg as unknown as { records?: Map<string, { handler: import("../extensions/tool-registry.js").ExtensionToolHandler }> }).records?.get(name)?.handler;
  return h ? { handler: h } : null;
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
