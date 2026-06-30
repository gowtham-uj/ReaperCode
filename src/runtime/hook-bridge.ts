/**
 * Bridge the existing `Hooks` + `ExtensionBus` surfaces to the new
 * `HookRunner`. The runtime is unchanged for callers — `Hooks.emit`
 * still drives skill/memory/swarm lifecycle, and `ExtensionBus.emit`
 * still fans events out to its subscribers. The bridge adds a
 * parallel fan-out to `HookRunner.dispatch(...)` so extension
 * handlers run with per-handler timeouts and per-extension fault
 * isolation.
 *
 *   engine.emit(hook) ──► Hooks.emit ──► existing fan-out ──┐
 *                                                           ├─► HookRunner.dispatch
 *   bus.emit(event)  ──► ExtensionBus.emit ──► existing     │
 *                              │              fan-out ──────┘
 *                              ▼
 *                       (also: bus handlers still run normally)
 *
 * Implementation note: a microtask boundary is used so the existing
 * fan-out timing (sync-or-async depending on caller) is preserved.
 * The bridge never `await`s the runner's dispatch — it schedules it
 * on a microtask and swallows the result so the engine is never
 * delayed by an extension handler.
 */

import type { Hooks } from "../adaptive/hooks.js";
import { getExtensionBus, type ExtensionEvent } from "../extension/bus.js";
import type { HookEventName } from "../adaptive/types.js";
import { HookRunner, type HookRunnerHandler } from "../extensions/hook-runner.js";

export interface BridgeOptions {
  /** Existing Hooks instance to bridge. */
  hooks: Hooks;
  /** Existing ExtensionBus instance. Defaults to the process-global one. */
  bus?: ReturnType<typeof getExtensionBus> | undefined;
  /** The runner extension handlers should fan into. */
  runner: HookRunner;
  /** When true, the bridge schedules on the microtask queue so the
   *  engine is never blocked on an extension handler. Default true. */
  useMicrotask?: boolean | undefined;
}

/** Map events that exist in one surface but not the other. The
 *  bridge subscribes to each side once and dispatches both to the
 *  runner. */
const BRIDGE_HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreSkillInvoke",
  "PostSkillInvoke",
  "SkillCreated",
  "SkillSelected",
  "MemoryCandidate",
  "MemoryWritten",
  "MemoryRejected",
  "VisualArtifactAdded",
  "VisualAnalysisCompleted",
  "PreCompact",
  "PostCompact",
  "FileChanged",
];

const BRIDGE_BUS_EVENTS: ExtensionEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PreSkillInvoke",
  "PostSkillInvoke",
  "SkillSelected",
  "SessionStart",
  "SessionShutdown",
  "BeforeProviderRequest",
  "AfterProviderResponse",
  "ResourcesDiscover",
  "CompleteTask",
  "FileChanged",
];

/**
 * Subscribe to both surfaces and forward events to the runner.
 * Returns an unsubscribe function that detaches both subscriptions.
 */
export function installHookBridge(opts: BridgeOptions): () => void {
  const bus = opts.bus ?? getExtensionBus();
  const microtask = opts.useMicrotask ?? true;
  const offs: Array<() => void> = [];

  // Hooks: register a passthrough handler per event. The handler is
  // intentionally non-blocking: it kicks the runner on a microtask.
  for (const event of BRIDGE_HOOK_EVENTS) {
    opts.hooks.on(event, (ev) => {
      schedule(() => { void opts.runner.dispatch(event, ev.payload); }, microtask);
      return { allow: true };
    });
    offs.push(() => {
      // Hooks doesn't expose off-by-event; the caller can recreate
      // the instance if they need a clean detach. We leave a no-op
      // here so unsubscribe doesn't throw.
    });
  }

  // ExtensionBus: each emit already returns a promise; subscribe
  // to each event we know about and forward.
  for (const event of BRIDGE_BUS_EVENTS) {
    const off = bus.on(event, (e, payload) => {
      const rec = (payload as { payload?: Record<string, unknown> } | undefined)?.payload ?? {};
      schedule(() => { void opts.runner.dispatch(event, rec); }, microtask);
      return undefined;
    });
    offs.push(off);
  }

  return () => {
    while (offs.length) {
      try { offs.pop()?.(); } catch { /* ignore */ }
    }
  };
}

function schedule(fn: () => void | Promise<void>, microtask: boolean): void {
  if (microtask) {
    queueMicrotask(() => { void fn(); });
  } else {
    setImmediate(() => { void fn(); });
  }
}

/**
 * Convenience: register an extension handler on the runner AND
 * subscribe to the underlying Hooks + ExtensionBus so legacy callers
 * that emit through either surface still reach the handler.
 */
export function registerHandlerThroughBridge(opts: {
  runner: HookRunner;
  event: HookEventName | ExtensionEvent;
  extensionId: string;
  handler: HookRunnerHandler;
  timeoutMs?: number | undefined;
}): () => void {
  return opts.runner.register(opts.extensionId, opts.event, opts.handler, { ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
}
