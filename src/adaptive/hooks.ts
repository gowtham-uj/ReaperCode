/**
 * Hooks for skills and memory.
 * Each hook handler receives a `HookEvent` and returns a `HookResult`.
 * The default policy is:
 *  - fail-open for observation-only events
 *  - fail-closed for `PreToolUse` security-relevant events (configurable)
 *
 * Hook output is size-limited (4KB by default) and secrets are
 * redacted before emission.
 */

import { redactSecrets } from "./redact.js";
import { getExtensionBus, type ExtensionEvent } from "../extension/bus.js";
import type { HookEvent, HookEventName, HookHandler, HookResult } from "./types.js";

const DEFAULT_OUTPUT_LIMIT = 4096;
const SECURITY_EVENTS: HookEventName[] = ["PreToolUse", "Stop", "UserPromptSubmit", "PreSkillInvoke"];

/** Map a HookEventName to the corresponding ExtensionBus event.
 *  Returns null when the bus has no matching event (e.g. "Stop",
 *  which is an engine-level event the bus does not mirror). */
function toExtensionEvent(name: HookEventName): ExtensionEvent | null {
  switch (name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PreSkillInvoke":
    case "PostSkillInvoke":
    case "SessionStart":
    case "SessionEnd":
    case "MemoryWritten":
    case "MemoryRejected":
    case "VisualArtifactAdded":
    case "VisualAnalysisCompleted":
    case "PreCompact":
    case "PostCompact":
      // Bus-level equivalents. We map any *additional* lifecycle
      // events the bus does not declare to a sensible "CompleteTask"
      // sentinel so consumers that listen on that get visibility.
      return name === "SessionEnd" ? "SessionShutdown" : null;
    case "UserPromptSubmit":
    case "SkillCreated":
    case "MemoryCandidate":
    case "PostToolUseFailure":
    case "AssistantStreamDelta":
    case "AssistantStreamComplete":
    case "AssistantMessageDelta":
    case "AssistantMessageComplete":
    case "ReasoningDelta":
    case "ReasoningComplete":
    case "EngineTurnComplete":
      return null;
    default:
      return null;
  }
}

export interface HooksOptions {
  /** Default fail policy for security-relevant events. */
  securityFailClosed?: boolean;
  /** Max bytes for any single hook result message. */
  outputLimit?: number;
}

export class Hooks {
  private handlers: Map<HookEventName, HookHandler[]> = new Map();
  private readonly securityFailClosed: boolean;
  private readonly outputLimit: number;

  constructor(opts: HooksOptions = {}) {
    this.securityFailClosed = opts.securityFailClosed ?? true;
    this.outputLimit = opts.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  }

  on(event: HookEventName, handler: HookHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: HookEventName, handler: HookHandler): boolean {
    const list = this.handlers.get(event);
    if (!list) return false;
    const idx = list.indexOf(handler);
    if (idx < 0) return false;
    list.splice(idx, 1);
    return true;
  }

  async emit(event: HookEvent): Promise<HookResult> {
    const list = this.handlers.get(event.name) ?? [];
    let result: HookResult = { allow: true };
    for (const h of list) {
      try {
        const r = await h(event);
        if (event.blockable && r.allow === false) {
          result = r;
          break;
        }
        if (r.message) {
          result = { ...result, message: [result.message, this.sanitize(r.message)].filter(Boolean).join("\n") };
        }
      } catch (e) {
        // Hook errors are fail-open by default. For security events, fail-closed.
        if (SECURITY_EVENTS.includes(event.name) && this.securityFailClosed) {
          result = { allow: false, reason: `hook error: ${e instanceof Error ? e.message : String(e)}` };
          break;
        }
        // otherwise: swallow and continue
      }
    }
    if (result.message) result.message = this.truncate(result.message);
    if (result.reason) result.reason = this.truncate(result.reason);
    // F4: fan out to the bus. We do this AFTER the local handlers
    // resolve so the bus sees the same effective result the
    // runtime got. The bus call is best-effort; bus errors are
    // swallowed because the runtime is already in a committed state.
    const busEvent = toExtensionEvent(event.name);
    if (busEvent) {
      getExtensionBus().emit(busEvent, { event: event.name, payload: event.payload, result }).catch(() => {});
    }
    return result;
  }

  private sanitize(text: string): string {
    const { redacted } = redactSecrets(text);
    return redacted;
  }

  private truncate(text: string): string {
    if (text.length <= this.outputLimit) return text;
    return text.slice(0, this.outputLimit) + "\n…(truncated)…";
  }
}
