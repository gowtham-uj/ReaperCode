import type { GenerateRequest, GenerateResult } from "../model/types.js";
import type { LoadedExtension } from "./types.js";

export type ExtensionLifecycleEvent =
  | { type: "project_trust"; workspaceRoot: string }
  | { type: "session_start"; reason: "new" | "resume" | "fork"; previousSessionFile?: string }
  | { type: "session_before_switch"; reason: "new" | "resume" | "fork"; targetSessionFile?: string }
  | { type: "session_shutdown"; reason: string; targetSessionFile?: string }
  | { type: "before_model_request"; role: string; source: string; request: GenerateRequest }
  | { type: "after_model_response"; role: string; source: string; request: GenerateRequest; response?: GenerateResult; usage?: unknown; error?: string }
  | { type: "before_tool_call"; toolName: string; args: unknown }
  | { type: "after_tool_call"; toolName: string; result: unknown }
  | { type: "before_compaction"; tokens: number }
  | { type: "after_compaction"; summary: string };

export type ExtensionLifecycleEventHandler = (event: ExtensionLifecycleEvent) => void | Promise<void>;

export interface ExtensionLifecycleDiagnostic {
  extensionId: string;
  eventType: ExtensionLifecycleEvent["type"];
  error: string;
}

export interface ExtensionLifecycleEmitOutcome {
  ok: boolean;
  dispatched: number;
  skipped: number;
  diagnostics: ExtensionLifecycleDiagnostic[];
}

interface Registration {
  extension: LoadedExtension;
  handler: ExtensionLifecycleEventHandler;
}

export class ExtensionLifecycleEventBus {
  private readonly registrations: Registration[] = [];

  register(extension: LoadedExtension, handler: ExtensionLifecycleEventHandler): () => void {
    const registration = { extension, handler };
    this.registrations.push(registration);
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index >= 0) this.registrations.splice(index, 1);
    };
  }

  unregister(extensionId: string): number {
    let removed = 0;
    for (let index = this.registrations.length - 1; index >= 0; index -= 1) {
      if (this.registrations[index]?.extension.id === extensionId) {
        this.registrations.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  async emit(event: ExtensionLifecycleEvent): Promise<ExtensionLifecycleEmitOutcome> {
    const diagnostics: ExtensionLifecycleDiagnostic[] = [];
    let dispatched = 0;
    let skipped = 0;
    for (const registration of this.registrations) {
      if (!canReceiveLifecycleEvents(registration.extension)) {
        skipped += 1;
        continue;
      }
      try {
        await registration.handler(event);
        dispatched += 1;
      } catch (error) {
        dispatched += 1;
        diagnostics.push({
          extensionId: registration.extension.id,
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: diagnostics.length === 0,
      dispatched,
      skipped,
      diagnostics,
    };
  }
}

export function canReceiveLifecycleEvents(extension: LoadedExtension): boolean {
  if (extension.status !== "enabled") return false;
  return extension.trust === "builtin" || extension.trust === "user-trusted";
}

let defaultLifecycleEventBus = new ExtensionLifecycleEventBus();

export function getExtensionLifecycleEventBus(): ExtensionLifecycleEventBus {
  return defaultLifecycleEventBus;
}

export function __resetExtensionLifecycleEventBusForTests(): void {
  defaultLifecycleEventBus = new ExtensionLifecycleEventBus();
}
