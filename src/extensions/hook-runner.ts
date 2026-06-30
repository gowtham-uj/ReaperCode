/**
 * HookRunner — extension hook dispatcher with per-handler timeouts
 * and per-extension fault isolation. Sits on top of (not in place
 * of) the existing `Hooks` class and `ExtensionBus`.
 *
 * Why a separate runner: `Hooks` is observation-only on most events
 * and has no per-handler timeout; extensions need both. `ExtensionBus`
 * is fan-in but does no gating and has no security-event fail-closed
 * default. The runner combines both:
 *   - per-handler timeout (default 5000ms; per-registration override)
 *   - per-extension fault isolation (one extension's error does not
 *     affect another)
 *   - security-event collapse: on `PreToolUse`, `Stop`,
 *     `UserPromptSubmit`, `PreSkillInvoke` a timeout or error with
 *     `securityFailClosed: true` produces `{ allow: false, reason }`
 *
 * The runner does NOT replace `Hooks.emit`; the existing fan-out to
 * `Hooks` + `ExtensionBus` is preserved. The bridge file
 * (`src/runtime/hook-bridge.ts`) wires the runner so the engine's
 * `Hooks.emit` and `getExtensionBus().emit` calls also reach it.
 */

import type { HookEventName, HookResult } from "../adaptive/types.js";
import type { ExtensionEvent } from "../extension/bus.js";

/** Hook event names that gate security-relevant operations. */
const SECURITY_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "Stop",
  "UserPromptSubmit",
  "PreSkillInvoke",
]);

/** Default per-handler timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000;

export interface HookHandlerEnvelope {
  event: HookEventName | ExtensionEvent;
  payload: Record<string, unknown>;
  blockable: boolean;
}

export type HookRunnerHandler = (env: HookHandlerEnvelope) =>
  | { allow: boolean; message?: string; reason?: string }
  | Promise<{ allow: boolean; message?: string; reason?: string }>;

export interface HookRegistrationOptions {
  /** Per-handler timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Whether the handler is allowed to block. Default true. */
  blockable?: boolean;
  /** Optional priority (lower runs first). Default 100. */
  priority?: number;
}

interface RegisteredHandler {
  extensionId: string;
  event: HookEventName | ExtensionEvent;
  handler: HookRunnerHandler;
  timeoutMs: number;
  blockable: boolean;
  priority: number;
}

export interface DispatchOutcome {
  allow: boolean;
  results: Array<{
    extensionId: string;
    outcome: "allow" | "deny" | "timeout" | "error" | "message";
    message?: string;
    reason?: string;
    durationMs: number;
  }>;
  /** First deny reason, if any. */
  firstDenyReason?: string;
}

export interface HookRunnerOptions {
  defaultTimeoutMs?: number;
  /** When true, security-event handler errors/timeouts collapse to deny. */
  securityFailClosed?: boolean;
}

/** Per-extension envelope wrapper used by ExtensionRegistry.activateOne. */
export interface RunWithExtensionResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

export class HookRunner {
  private readonly handlers: RegisteredHandler[] = [];
  private readonly defaultTimeoutMs: number;
  private readonly securityFailClosed: boolean;

  constructor(opts: HookRunnerOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.securityFailClosed = opts.securityFailClosed ?? true;
  }

  /** Register a handler for `event`. Returns an unsubscribe fn. */
  register(
    extensionId: string,
    event: HookEventName | ExtensionEvent,
    handler: HookRunnerHandler,
    opts: HookRegistrationOptions = {},
  ): () => void {
    const reg: RegisteredHandler = {
      extensionId,
      event,
      handler,
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
      blockable: opts.blockable ?? true,
      priority: opts.priority ?? 100,
    };
    this.handlers.push(reg);
    this.handlers.sort((a, b) => a.priority - b.priority);
    return () => this.unregisterOne(extensionId, event, handler);
  }

  /** Drop every handler for `extensionId`. */
  unregisterAll(extensionId: string): number {
    let removed = 0;
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i];
      if (h && h.extensionId === extensionId) {
        this.handlers.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Dispatch `event` to all matching handlers. Per-handler timeout;
   * a single timeout/error never blocks the others. Security events
   * collapse to `allow: false` on the first timeout/error when
   * `securityFailClosed` is on.
   */
  async dispatch(event: HookEventName | ExtensionEvent, payload: Record<string, unknown>): Promise<DispatchOutcome> {
    const list = this.handlers.filter((h) => h.event === event);
    const isSecurity = SECURITY_EVENTS.has(event as HookEventName);
    const out: DispatchOutcome = { allow: true, results: [] };
    for (const h of list) {
      const start = Date.now();
      try {
        const timedOut = { hit: false };
        const onTimeout = () => { timedOut.hit = true; };
        // Race the handler against the per-handler timeout. If the
        // timeout wins, the inner promise still resolves but we
        // discard its result; the runtime never sees it.
        const handlerPromise = Promise.resolve().then(() => h.handler({ event, payload, blockable: h.blockable }));
        const result = await Promise.race([
          handlerPromise,
          new Promise<{ allow: boolean }>((resolve) => {
            const timer = setTimeout(() => { onTimeout(); resolve({ allow: true }); }, h.timeoutMs);
            if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
          }),
        ]);
        const duration = Date.now() - start;
        if (timedOut.hit) {
          out.results.push({ extensionId: h.extensionId, outcome: "timeout", reason: `timeout after ${h.timeoutMs}ms`, durationMs: duration });
          if (isSecurity && this.securityFailClosed) {
            out.allow = false;
            if (!out.firstDenyReason) out.firstDenyReason = `hook timeout after ${h.timeoutMs}ms`;
            if (h.blockable) break;
          }
          continue;
        }
        if (result.allow === false) {
          const reason = "reason" in result ? result.reason : undefined;
          const message = "message" in result ? result.message : undefined;
          out.results.push({ extensionId: h.extensionId, outcome: "deny", ...(reason ? { reason } : {}), ...(message ? { message } : {}), durationMs: duration });
          out.allow = false;
          if (!out.firstDenyReason && reason) out.firstDenyReason = reason;
          if (h.blockable) break;
        } else if ("message" in result && result.message) {
          out.results.push({ extensionId: h.extensionId, outcome: "message", message: result.message, durationMs: duration });
        } else {
          out.results.push({ extensionId: h.extensionId, outcome: "allow", durationMs: duration });
        }
      } catch (e) {
        const duration = Date.now() - start;
        const reason = e instanceof Error ? e.message : String(e);
        out.results.push({ extensionId: h.extensionId, outcome: "error", reason, durationMs: duration });
        if (isSecurity && this.securityFailClosed) {
          out.allow = false;
          if (!out.firstDenyReason) out.firstDenyReason = `hook error: ${reason}`;
          if (h.blockable) break;
        }
      }
    }
    return out;
  }

  /**
   * Wrap an extension's `activate(ctx)` call. Top-level timeout is
   * the larger of `defaultTimeoutMs` and the explicit arg, capped
   * at 60s. A throw inside the wrapped fn returns `{ok:false,error}`
   * instead of bubbling.
   */
  async runWithExtension(extensionId: string, fn: () => Promise<void> | void, explicitTimeoutMs?: number): Promise<RunWithExtensionResult> {
    const start = Date.now();
    const timeoutMs = Math.min(60_000, Math.max(this.defaultTimeoutMs, explicitTimeoutMs ?? 0));
    let timerFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.resolve().then(() => fn());
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => { timerFired = true; resolve(); }, timeoutMs);
        if (typeof (timer as { unref?: () => void })?.unref === "function") (timer as { unref: () => void }).unref();
      });
      await Promise.race([work, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (timerFired) {
        return { ok: false, error: `[${extensionId}] activate timed out after ${timeoutMs}ms`, durationMs: Date.now() - start };
      }
      return { ok: true, durationMs: Date.now() - start };
    } catch (e) {
      if (timer !== undefined) clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `[${extensionId}] activate failed: ${msg}`, durationMs: Date.now() - start };
    }
  }

  /** Test hook: drop every registered handler. */
  clear(): void {
    this.handlers.length = 0;
  }

  /** Diagnostic: count registered handlers for an event. */
  listenerCount(event: HookEventName | ExtensionEvent): number {
    return this.handlers.filter((h) => h.event === event).length;
  }

  private unregisterOne(extensionId: string, event: HookEventName | ExtensionEvent, handler: HookRunnerHandler): boolean {
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i];
      if (h && h.extensionId === extensionId && h.event === event && h.handler === handler) {
        this.handlers.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}

/**
 * Map a HookEventName to a HookResult (used by adapter code that
 * bridges an existing `Hooks` instance into the runner).
 */
export function outcomeToHookResult(out: DispatchOutcome): HookResult {
  if (out.allow) {
    const firstMessage = out.results.find((r) => r.outcome === "message")?.message;
    return firstMessage ? { allow: true, message: firstMessage } : { allow: true };
  }
  return { allow: false, reason: out.firstDenyReason ?? "denied by extension hook" };
}
