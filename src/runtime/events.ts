import { redactSecrets } from "../logging/redaction.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

export type RuntimeEventData =
  | { type: "turn.started"; runId: string; sessionId: string }
  | { type: "turn.completed"; runId: string; sessionId: string; assistantMessage: string }
  | { type: "turn.aborted"; runId: string; sessionId: string; reason?: string }
  | { type: "turn.failed"; runId: string; sessionId: string; error: { name: string; message: string } }
  | { type: "assistant.message.delta"; text: string }
  | { type: "assistant.message.completed"; text: string }
  | { type: "assistant.reasoning.delta"; text: string }
  | { type: "assistant.reasoning.completed"; text: string }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.completed"; toolCall: ToolCall; result: ToolResult }
  | { type: "tool.failed"; toolCall: ToolCall; error: { name: string; message: string } }
  | { type: "command.output.delta"; toolCallId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "verification.started"; command?: string }
  | { type: "verification.completed"; ok: boolean; command?: string; summary?: string }
  | { type: "compaction.updated"; phase: "started" | "completed" | "failed"; savedChars?: number }
  | { type: "token.usage"; inputTokens: number; outputTokens: number }
  | { type: "approval.requested"; approvalId: string; toolCallId: string; toolName: string; reason: string }
  | { type: "approval.resolved"; approvalId: string; toolCallId: string; decision: "approved" | "denied" | "cancelled" | "timeout" }
  | { type: "warning"; code: string; message: string }
  | { type: "error"; code: string; message: string };

export type RuntimeEvent = RuntimeEventData & { timestamp: string };
export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;

/** Event delivery is fail-open so a disconnected UI cannot crash an agent run. */
export async function emitRuntimeEvent(
  sink: RuntimeEventSink | undefined,
  event: RuntimeEventData,
): Promise<void> {
  if (!sink) return;
  try {
    const safe = redactSecrets({ ...event, timestamp: new Date().toISOString() }) as RuntimeEvent;
    await sink(safe);
  } catch {
    // Transport observers are not part of runtime correctness.
  }
}

export interface SteeringResult {
  accepted: boolean;
  reason?: "closed" | "queue_full" | "empty";
}

/**
 * Per-turn steering inbox. JavaScript's synchronous sections make enqueue and
 * drain-or-close atomic relative to one another, which prevents an accepted
 * steer from landing after the engine has committed to a terminal stop.
 */
export class RuntimeTurnControl {
  private readonly queue: string[] = [];
  private accepting = true;

  constructor(private readonly maxQueuedMessages = 32) {}

  steer(message: string): SteeringResult {
    const normalized = message.trim();
    if (!normalized) return { accepted: false, reason: "empty" };
    if (!this.accepting) return { accepted: false, reason: "closed" };
    if (this.queue.length >= this.maxQueuedMessages) {
      return { accepted: false, reason: "queue_full" };
    }
    this.queue.push(normalized);
    return { accepted: true };
  }

  drain(): string[] {
    return this.queue.splice(0, this.queue.length);
  }

  /** Drain accepted messages; close the steering window when none remain. */
  drainOrClose(): { messages: string[]; closed: boolean } {
    const messages = this.drain();
    if (messages.length > 0) return { messages, closed: false };
    this.accepting = false;
    return { messages: [], closed: true };
  }

  close(): string[] {
    this.accepting = false;
    return this.drain();
  }

  get isOpen(): boolean {
    return this.accepting;
  }
}
