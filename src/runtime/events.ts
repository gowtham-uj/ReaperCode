import { redactSecrets } from "../logging/redaction.js";
import type { PlanStep, TodoItem } from "./plan-state.js";
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
  /**
   * Output from a *background* process — one that outlived the tool call that
   * started it. Distinct from `command.output.delta`, which belongs to a
   * foreground call and is keyed by `toolCallId`: a background process has no
   * live tool call to attach to, so it is keyed by pid and carries its command
   * so a client can label it without holding a separate registry.
   */
  | { type: "background.output.delta"; pid: number; stream: "stdout" | "stderr" | "system"; text: string; cmd: string }
  /** A loopback dev server announced itself in background output. */
  | { type: "background.server.detected"; pid: number; url: string; port: number }
  | { type: "verification.started"; command?: string }
  /**
   * The verification verdict. `ok` means every command exited 0; `verified`
   * additionally means the evidence was *grounded* in a real test/build/
   * typecheck/lint/artifact signal (not `echo done`). `groundedSignal` names
   * which kind of signal grounded it, so the panel can answer the trust
   * question — did it actually pass, or fake it?
   */
  | {
      type: "verification.completed";
      ok: boolean;
      command?: string;
      summary?: string;
      verified?: boolean;
      groundedSignal?: { kind: string; command: string; grounded: boolean };
      failureClasses?: string[];
      feedback?: string[];
      attemptCount?: number;
      selfDebugExplanation?: string;
      diffReviewExplanation?: string;
    }
  /**
   * The typed plan and todo checklists. Emitted when an `update_plan` /
   * `update_todo` advisory call changes them, so the UI can render the same
   * checklist the cockpit shows the model — without re-implementing the merge.
   */
  | { type: "plan.updated"; steps: PlanStep[] }
  | { type: "todo.updated"; items: TodoItem[] }
  | {
      /**
       * One context-management technique ran, is running, or failed.
       *
       * Reaper shrinks a conversation several ways and they are not
       * interchangeable: shake drops stale tool output, tool-history compaction
       * replaces a run of results with summaries, full summarization calls a
       * model to rewrite the whole middle, and so on. A user watching a
       * transcript needs to know which one happened and how much it reclaimed,
       * because that is the difference between "the agent forgot" and "the
       * agent deliberately dropped 40 stale file reads".
       *
       * Every field but `phase` and `technique` is optional: the cheapest pass
       * knows only a character count, and a model-call summary knows tokens and
       * message counts but not the exact character delta.
       */
      type: "context.updated";
      phase: "started" | "completed" | "failed";
      technique: ContextTechnique;
      /** Characters removed from the conversation. */
      savedChars?: number;
      /** Tokens removed, when the technique measured them. */
      savedTokens?: number;
      /** Message count before and after, when the technique removes messages. */
      messagesBefore?: number;
      messagesAfter?: number;
      /** Provider-reported input tokens at the moment it fired. */
      usedTokens?: number;
      /** Reaper's soft budget then in force, for the meter's denominator. */
      softCap?: number;
      /**
       * A short note for the transcript, e.g. "3 superseded tool results
       * dropped". Distinct from `reason`, which means the technique failed.
       */
      detail?: string;
      /** Why it failed. Present only on `phase: "failed"`. */
      reason?: string;
    }
  | {
      type: "token.usage";
      inputTokens: number;
      outputTokens: number;
      /**
       * The active model's context window (tokens), when the resolved profile
       * advertises one. Distinct from Reaper's own soft cap: a model may offer
       * 1M while Reaper only budgets up to 270k.
       */
      modelContextWindow?: number;
      /** Reaper's soft context budget (tokens). Defaults to the 270k hard cap. */
      contextSoftCap?: number;
      /**
       * The maximum output the request asked for, when it declared one.
       * Subtracted from the limit before computing pressure: the reservation
       * is part of the budget, so a 200k window with a 32k reservation holds
       * about 168k of prompt.
       */
      reservedOutputTokens?: number;
      /** The model this usage is for, so the meter can name it. */
      model?: string;
    }
  | { type: "approval.requested"; approvalId: string; toolCallId: string; toolName: string; reason: string }
  | { type: "approval.resolved"; approvalId: string; toolCallId: string; decision: "approved" | "denied" | "cancelled" | "timeout" }
  | { type: "warning"; code: string; message: string }
  | { type: "error"; code: string; message: string };

/**
 * The context-management techniques a transcript can report.
 *
 * Named for the mechanism, not the effect, because two of them can free the
 * same number of characters and mean very different things. `shake` drops
 * output the conversation has moved past; `full_summary` is a model call that
 * rewrites the middle and is the only one that can lose detail a user cared
 * about. Collapsing them into one "compacted" label would hide that.
 */
export type ContextTechnique =
  | "supersede"
  | "tool_output_prune"
  | "bash_head_tail"
  | "shake"
  | "microcompact"
  | "tool_history"
  | "snapcompact"
  | "full_summary"
  | "handoff_summary"
  | "idle_compaction"
  | "incomplete_recovery"
  | "ptl_recovery"
  | "model_promotion";

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

  /**
   * @param onDrain Called with the messages the engine has just taken, at the
   *   moment it takes them. Steering is accepted immediately but not *delivered*
   *   until the next model request, so an observer that reports acceptance as
   *   delivery tells the user their message is in the conversation while the
   *   agent has not yet seen it. This hook is the delivery moment.
   */
  constructor(
    private readonly maxQueuedMessages = 32,
    private readonly onDrain?: (messages: string[]) => void,
  ) {}

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
    const messages = this.take();
    if (messages.length > 0) this.onDrain?.(messages);
    return messages;
  }

  /** Drain accepted messages; close the steering window when none remain. */
  drainOrClose(): { messages: string[]; closed: boolean } {
    const messages = this.drain();
    if (messages.length > 0) return { messages, closed: false };
    this.accepting = false;
    return { messages: [], closed: true };
  }

  /**
   * Close the window, discarding anything still queued. The discarded messages
   * were accepted but never delivered to a model, so this deliberately does NOT
   * fire `onDrain` — a delivery callback would claim the model saw them.
   */
  close(): string[] {
    this.accepting = false;
    return this.take();
  }

  private take(): string[] {
    return this.queue.splice(0, this.queue.length);
  }

  get isOpen(): boolean {
    return this.accepting;
  }
}
