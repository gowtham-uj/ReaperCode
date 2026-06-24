/**
 * F4: typed extension-event bus.
 *
 * Reaper has three independent hook surfaces:
 *   - `Hooks` (adaptive/hooks.ts) — skill/memory/swarm lifecycle.
 *   - `SubagentHookEngine` (swarm/runner.ts) — subagent invocations.
 *   - `MiddlewareDefinition.onContentPrep` (runtime/middleware.ts) —
 *     runs on every model-call prep.
 *
 * They each model their own subset of the same lifecycle. The bus
 * exposes a single typed event surface and gives the existing
 * three layers a place to forward their events. Consumers can
 * register a single handler and receive every event in one place.
 *
 * This is additive: the existing APIs keep their current shape. The
 * bus is the canonical "fan-in" point.
 */

export type ExtensionEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSkillInvoke"
  | "PostSkillInvoke"
  | "SkillSelected"
  | "SessionStart"
  | "SessionShutdown"
  | "BeforeProviderRequest"
  | "AfterProviderResponse"
  | "ResourcesDiscover"
  | "CompleteTask"
  | "FileChanged";

export type ExtensionHandler<E extends ExtensionEvent = ExtensionEvent> = (
  event: E,
  payload: unknown,
) => Promise<unknown> | unknown;

export class ExtensionBus {
  private handlers = new Map<ExtensionEvent, ExtensionHandler[]>();

  on<E extends ExtensionEvent>(event: E, handler: ExtensionHandler<E>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as ExtensionHandler);
    this.handlers.set(event, list);
    return () => this.off(event, handler);
  }

  off<E extends ExtensionEvent>(event: E, handler: ExtensionHandler<E>): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler as ExtensionHandler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Emit an event to all registered handlers. Handlers run in
   * registration order. Errors from one handler do not stop the
   * others; the first error is captured and returned alongside the
   * successful results.
   */
  async emit<E extends ExtensionEvent>(event: E, payload: unknown): Promise<{
    results: unknown[];
    firstError: unknown;
  }> {
    const list = this.handlers.get(event) ?? [];
    const results: unknown[] = [];
    let firstError: unknown;
    for (const h of list) {
      try {
        const out = await h(event, payload);
        results.push(out);
      } catch (e) {
        if (firstError === undefined) firstError = e;
      }
    }
    return { results, firstError };
  }

  /** Synchronous emit for non-async handlers. Errors are caught
   *  and recorded but do not throw. */
  emitSync<E extends ExtensionEvent>(event: E, payload: unknown): { results: unknown[]; firstError: unknown } {
    const list = this.handlers.get(event) ?? [];
    const results: unknown[] = [];
    let firstError: unknown;
    for (const h of list) {
      try {
        const out = h(event, payload);
        if (out && typeof (out as { then?: unknown }).then === "function") {
          // Skip async handlers in sync mode rather than awaiting.
          results.push(undefined);
          continue;
        }
        results.push(out);
      } catch (e) {
        if (firstError === undefined) firstError = e;
      }
    }
    return { results, firstError };
  }

  /** Remove all handlers. Used by tests. */
  clear(): void {
    this.handlers.clear();
  }

  /** Number of handlers for a given event. Diagnostic only. */
  listenerCount(event: ExtensionEvent): number {
    return (this.handlers.get(event) ?? []).length;
  }
}

let globalBus: ExtensionBus | null = null;

/** Process-global extension bus. Lazily created. */
export function getExtensionBus(): ExtensionBus {
  if (!globalBus) globalBus = new ExtensionBus();
  return globalBus;
}

/** Test-only: drop the global bus. */
export function __resetExtensionBusForTests(): void {
  globalBus = null;
}
