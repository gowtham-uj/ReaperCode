import type { ContextTechnique } from "../runtime/events.js";
import type { SessionMessage } from "../context/session-journal.js";
import type { PlanStep, TodoItem } from "../runtime/plan-state.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { ThreadEventRecord } from "./event-bus.js";
import type { ThreadMetadata } from "./thread-store.js";

export type AppTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type AppThreadItem =
  | { type: "userMessage"; id: string; content: Array<{ type: "text"; text: string }> }
  | { type: "agentMessage"; id: string; text: string; phase: "commentary" | "final_answer" }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "commandExecution"; id: string; command: string; cwd?: string; status: "inProgress" | "completed" | "failed"; aggregatedOutput?: string; exitCode?: number; durationMs?: number }
  | { type: "fileChange"; id: string; changes: Array<{ path: string; kind: string; diff?: string }>; status: "inProgress" | "completed" | "failed" }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: Record<string, unknown>;
      status: "inProgress" | "completed" | "failed";
      result?: unknown;
      error?: string;
      /**
       * Sandbox output produced while the call runs; dropped when it finishes.
       *
       * Only Code Mode fills this, and only for the window between started and
       * completed: after that the result carries the same output with its
       * structure intact, and holding both would double the bytes for no extra
       * information. It exists so a client that connects *during* a long script
       * still sees it moving, which the bare delta stream cannot provide.
       */
      liveOutput?: Array<{ kind: string; text: string }>;
    }
  | {
      /**
       * One context-management technique, as a transcript row.
       *
       * Replaces a bare `contextCompaction` marker that carried nothing but an
       * id. That item could only ever say "something happened"; a user watching
       * an agent work wants to know which technique ran and how much it
       * reclaimed, because dropping 40 stale file reads and rewriting the whole
       * conversation with a model are very different events.
       *
       * `status` matters for the same reason: full summarization involves a
       * model call that takes seconds, and the row should be visibly in flight
       * rather than appearing only once it is over.
       */
      type: "contextManagement";
      id: string;
      technique: ContextTechnique;
      status: "inProgress" | "completed" | "failed";
      savedChars?: number;
      savedTokens?: number;
      messagesBefore?: number;
      messagesAfter?: number;
      usedTokens?: number;
      softCap?: number;
      detail?: string;
      error?: string;
    };

/** Cap on parked live output for one Code Mode call, by line count. */
const MAX_LIVE_OUTPUT_LINES = 400;

export interface AppTurn {
  id: string;
  status: AppTurnStatus;
  items: AppThreadItem[];
  error?: { message: string; additionalDetails?: string };
}

export interface AppThread {
  id: string;
  sessionId: string;
  preview: string;
  ephemeral: false;
  cwd: string;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  /** Extra instructions appended after the built-in agent prompt. */
  systemPrompt?: string;
  /** Tool names this thread's agent must not call. */
  disabledTools?: string[];
  /** Whether any turn has ever run here — see `projectThread`. */
  hasTurns: boolean;
  approvalPolicy?: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  status: "notLoaded" | "idle" | "systemError" | { type: "active"; activeFlags: string[] };
  turns?: AppTurn[];
}

export interface ProjectedNotification {
  method: string;
  params: Record<string, unknown>;
}

interface MutableTurn {
  turn: AppTurn;
  items: Map<string, AppThreadItem>;
  /**
   * Which model request the turn is currently on. A turn is a sequence of
   * steps — one model request plus the tools it calls — and each step gets its
   * own message and reasoning items. Without this, every step reused one id, so
   * a second step *overwrote* the first's prose and rendered at the first's
   * position, above the tool calls that actually preceded it.
   */
  step: number;
  /** Whether the current step has run a tool, i.e. whether prose opens a new one. */
  stepHasTool: boolean;
  /**
   * Whether the current step's prose is still streaming. A runner may emit
   * deltas for one continuous message either side of a tool call — that is one
   * model response, not two steps. Advancing on the tool alone would split it
   * into two bubbles with the tool wedged between them.
   */
  stepProseOpen: boolean;
}

/**
 * Step 0 keeps the unsuffixed id so single-step turns — the overwhelming
 * majority — project exactly the ids they always have.
 */
function stepItemId(turnId: string, kind: string, step: number): string {
  return step === 0 ? `${turnId}:${kind}` : `${turnId}:${kind}-${step}`;
}

/**
 * Upper bound on the accumulated output held per command item. Matches the
 * bash tool's own in-memory buffer cap. Without this a long build grows the
 * projection unboundedly, and every connected client mirrors it.
 */
const MAX_AGGREGATED_OUTPUT_CHARS = 256 * 1024;
const OUTPUT_TRUNCATION_MARKER = "[... earlier output truncated ...]\n";

function capOutput(text: string): string {
  if (text.length <= MAX_AGGREGATED_OUTPUT_CHARS) return text;
  const tail = text.slice(-(MAX_AGGREGATED_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length));
  return `${OUTPUT_TRUNCATION_MARKER}${tail}`;
}

export class SessionProjection {
  private readonly turns = new Map<string, MutableTurn>();
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  /**
   * The typed plan and todo checklists. Retained so a late-joining client can
   * be handed the current state even when the `plan.updated` / `todo.updated`
   * events that produced it have aged out of the replay ring.
   */
  private planSteps: PlanStep[] | undefined;
  private todoItems: TodoItem[] | undefined;
  /**
   * The most recent verification verdict. Retained so a late-joining client
   * that missed the `verification.completed` event still sees whether the agent
   * actually passed, or merely claimed to.
   */
  private verification: Record<string, unknown> | undefined;

  /**
   * Project one recorded event, folding in the owning thread's current
   * metadata for the events that describe the thread itself.
   *
   * `metadata` is live, not historical: only `thread.started` reads it, and it
   * must be current rather than the value at the time the event was recorded.
   * A replayed `thread.started` is how a reconnecting client relearns what a
   * thread is set to, so serving the creation-time snapshot would hand back a
   * pre-configuration view of a thread that has since been configured.
   * `isReplayStable` marks the projections that are a pure function of the
   * record and may therefore be memoized.
   */
  project(record: ThreadEventRecord, metadata?: ThreadMetadata): ProjectedNotification[] {
    const threadId = record.threadId;
    const turnId = record.turnId;
    const event = record.event;
    const base = {
      threadId,
      ...(turnId ? { turnId } : {}),
      sequence: record.sequence,
      timestamp: record.timestamp,
    };

    switch (event.type) {
      case "thread.started":
        return [{ method: "thread/started", params: { ...base, thread: metadata ? projectThread(metadata) : { id: threadId } } }];
      case "thread.status.changed":
        return [{ method: "thread/status/changed", params: { ...base, status: projectStatus(event.status) } }];
      case "thread.closed":
        return [{ method: "thread/closed", params: base }];
      case "turn.queued":
        return [{ method: "turn/queued", params: base }];
      case "turn.user.message": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        // A turn can carry more than one user message: the opening prompt plus
        // any message steered in at a model-loop boundary. Ordinal-suffix the id
        // so a queued follow-up appends instead of overwriting the prompt.
        // A steered message is delivered at a model-loop boundary, so like agent
        // prose it opens the next step and sorts after the tool calls it follows.
        this.beginProseStep(mutable);
        const ordinal = [...mutable.items.keys()].filter((id) => id.startsWith(`${turnId}:user-message`)).length;
        const item: AppThreadItem = {
          type: "userMessage",
          id: ordinal === 0 ? `${turnId}:user-message` : `${turnId}:user-message-${ordinal}`,
          content: [{ type: "text", text: event.text }],
        };
        this.putItem(mutable, item);
        // The opening prompt is ordinal 0, and `turn.started` below already
        // replays every item buffered before the turn began — notifying it here
        // too would render it twice. Only a message steered in afterwards needs
        // its own notification; without one it would sit invisible until the
        // next reload.
        return ordinal === 0 ? [] : [this.itemStarted(base, item)];
      }
      case "turn.interrupt.requested":
        return [{ method: "turn/interruptRequested", params: base }];
      case "turn.started": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        mutable.turn.status = "inProgress";
        const notifications: ProjectedNotification[] = [{
          method: "turn/started",
          params: { ...base, turn: { id: turnId, status: "inProgress", items: [] } },
        }];
        for (const item of mutable.items.values()) {
          notifications.push(this.itemStarted(base, item), this.itemCompleted(base, item));
        }
        return notifications;
      }
      case "assistant.message.delta": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        this.beginProseStep(mutable);
        const itemId = stepItemId(turnId, "agent-message", mutable.step);
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "agentMessage" }> = existing?.type === "agentMessage"
          ? existing
          : { type: "agentMessage", id: itemId, text: "", phase: "final_answer" };
        const started = existing ? [] : [this.itemStarted(base, item)];
        mutable.stepProseOpen = true;
        item.text += event.text;
        this.putItem(mutable, item);
        return [...started, { method: "item/agentMessage/delta", params: { ...base, itemId, delta: event.text } }];
      }
      case "assistant.message.completed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        this.beginProseStep(mutable);
        const itemId = stepItemId(turnId, "agent-message", mutable.step);
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "agentMessage" }> = existing?.type === "agentMessage"
          ? existing
          : { type: "agentMessage", id: itemId, text: "", phase: "final_answer" };
        if (event.text) item.text = event.text;
        // The message is closed, so the next tool call genuinely ends this step.
        mutable.stepProseOpen = false;
        this.putItem(mutable, item);
        return [this.itemCompleted(base, item)];
      }
      case "assistant.reasoning.delta": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        this.beginProseStep(mutable);
        const itemId = stepItemId(turnId, "reasoning", mutable.step);
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "reasoning" }> = existing?.type === "reasoning"
          ? existing
          : { type: "reasoning", id: itemId, summary: [], content: [] };
        const started = existing ? [] : [this.itemStarted(base, item)];
        item.content.push(event.text);
        this.putItem(mutable, item);
        return [...started, { method: "item/reasoning/textDelta", params: { ...base, itemId, delta: event.text } }];
      }
      case "assistant.reasoning.completed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        this.beginProseStep(mutable);
        const itemId = stepItemId(turnId, "reasoning", mutable.step);
        const existing = mutable.items.get(itemId);
        const item: Extract<AppThreadItem, { type: "reasoning" }> = existing?.type === "reasoning"
          ? existing
          : { type: "reasoning", id: itemId, summary: [], content: [] };
        if (event.text) item.content = [event.text];
        this.putItem(mutable, item);
        return [this.itemCompleted(base, item)];
      }
      case "tool.started": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        // A tool call closes the current step: whatever the model says next
        // came from a new model request and belongs after this call, not
        // merged into the prose that preceded it.
        mutable.stepHasTool = true;
        const item = toolItem(event.toolCall, "inProgress");
        this.putItem(mutable, item);
        return [this.itemStarted(base, item)];
      }
      case "command.output.delta": {
        if (!turnId) return [];
        const existing = this.ensureTurn(turnId).items.get(event.toolCallId);
        if (existing?.type === "commandExecution") {
          existing.aggregatedOutput = capOutput(`${existing.aggregatedOutput ?? ""}${event.text}`);
          return [{
            method: "item/commandExecution/outputDelta",
            params: { ...base, itemId: event.toolCallId, delta: event.text, stream: event.stream },
          }];
        }
        /*
         * Code Mode streams on the same channel a shell command uses, because
         * from the model's side it is the same thing: output produced *by* the
         * call, as it happens. But it is not a command execution and must not
         * be projected as one — the item is a `dynamicToolCall`, its output has
         * kinds (console levels, tool crossings) that a raw shell stream has no
         * way to express, and it is cleared the moment the real report lands.
         * So it gets its own notification rather than being folded into an
         * `aggregatedOutput` string that would be thrown away a second later.
         */
        if (existing?.type !== "dynamicToolCall") return [];
        const kind = event.stream === "stderr" ? "error" : "log";
        const lines = [...(existing.liveOutput ?? [])];
        const last = lines[lines.length - 1];
        if (last && last.kind === kind && !last.text.endsWith("\n")) {
          lines[lines.length - 1] = { kind, text: `${last.text}${event.text}` };
        } else {
          lines.push({ kind, text: event.text });
        }
        existing.liveOutput = lines.length > MAX_LIVE_OUTPUT_LINES ? lines.slice(-MAX_LIVE_OUTPUT_LINES) : lines;
        return [{
          method: "turn/codeMode/delta",
          params: { ...base, itemId: event.toolCallId, tool: existing.tool, text: event.text, kind },
        }];
      }
      /**
       * Background output is a *thread-level* stream, not a turn item.
       *
       * The process outlives the turn that started it, so attaching its output
       * to that turn's transcript would keep appending to a completed turn for
       * the rest of the session. It is forwarded as a notification and held by
       * the client in its own Output pane, keyed by pid.
       *
       * Note this shares the bounded replay ring with transcript events, so a
       * very chatty dev server shortens the reconnect window. That degrades to
       * `replay_truncated`, which the client already recovers from by refetching
       * the journal — history is never lost, only the fast path.
       */
      case "background.output.delta":
        return [{
          method: "background/outputDelta",
          params: { ...base, pid: event.pid, stream: event.stream, delta: event.text, cmd: event.cmd },
        }];
      case "background.server.detected":
        return [{
          method: "background/serverDetected",
          params: { ...base, pid: event.pid, url: event.url, port: event.port },
        }];
      case "tool.completed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const item = completeToolItem(mutable.items.get(event.toolCall.id), event.toolCall, event.result);
        this.putItem(mutable, item);
        return [this.itemCompleted(base, item)];
      }
      case "tool.failed": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);
        const current = mutable.items.get(event.toolCall.id) ?? toolItem(event.toolCall, "failed");
        setItemFailed(current, event.error.message);
        this.putItem(mutable, current);
        return [this.itemCompleted(base, current)];
      }
      case "context.updated": {
        if (!turnId) return [];
        const mutable = this.ensureTurn(turnId);

        /*
         * One row per technique per turn, keyed by the technique name.
         *
         * A turn can run the same technique more than once (a long tool loop
         * shakes repeatedly), and each occurrence should accumulate into the
         * row already on screen rather than adding another one. The counts add
         * up because that is what the user is watching: "shake saved 8k" three
         * times is really "shake saved 24k so far".
         */
        const id = `${turnId}:ctx:${event.technique}`;
        const existing = findItem(mutable, id);
        const prior = existing?.type === "contextManagement" ? existing : undefined;

        // `started` carries no numbers for most techniques, so a prior
        // completed row's totals survive a restart of the same technique
        // instead of being wiped by an empty start.
        const savedChars = sumField(prior?.savedChars, event.savedChars);
        const savedTokens = sumField(prior?.savedTokens, event.savedTokens);

        const item: Extract<AppThreadItem, { type: "contextManagement" }> = {
          type: "contextManagement",
          id,
          technique: event.technique,
          status: event.phase === "started" ? "inProgress" : event.phase === "failed" ? "failed" : "completed",
          ...(savedChars !== undefined ? { savedChars } : {}),
          ...(savedTokens !== undefined ? { savedTokens } : {}),
          // Message counts and the context snapshot describe *this* run of the
          // technique, so they are overwritten rather than summed.
          ...(event.messagesBefore !== undefined ? { messagesBefore: event.messagesBefore } : {}),
          ...(event.messagesAfter !== undefined ? { messagesAfter: event.messagesAfter } : {}),
          ...(event.usedTokens !== undefined ? { usedTokens: event.usedTokens } : {}),
          ...(event.softCap !== undefined ? { softCap: event.softCap } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.reason !== undefined ? { error: event.reason } : {}),
        };
        this.putItem(mutable, item);

        // A `started` phase is announced as a start so the row appears while
        // the technique runs; every terminal phase completes it.
        return [
          item.status === "inProgress" ? this.itemStarted(base, item) : this.itemCompleted(base, item),
        ];
      }
      case "turn.completed":
        return turnId ? this.turnCompleted(base, turnId, "completed") : [];
      case "turn.aborted":
        return turnId ? this.turnCompleted(base, turnId, "interrupted") : [];
      case "turn.failed":
        return turnId ? this.turnCompleted(base, turnId, "failed", event.error.message) : [];
      case "token.usage": {
        // `token.usage` carries per-call counts only, so the running total is
        // accumulated here. The event also carries the active model's window
        // and Reaper's soft cap (both resolved at emit time) so the context
        // meter can draw its thresholds without the client guessing.
        this.cumulativeInputTokens += event.inputTokens;
        this.cumulativeOutputTokens += event.outputTokens;
        return [{
          method: "thread/tokenUsage/updated",
          params: {
            ...base,
            tokenUsage: {
              total: {
                inputTokens: this.cumulativeInputTokens,
                outputTokens: this.cumulativeOutputTokens,
                totalTokens: this.cumulativeInputTokens + this.cumulativeOutputTokens,
              },
              last: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.inputTokens + event.outputTokens },
              modelContextWindow: typeof event.modelContextWindow === "number" ? event.modelContextWindow : null,
              contextSoftCap: typeof event.contextSoftCap === "number" ? event.contextSoftCap : undefined,
            },
          },
        }];
      }
      case "verification.started":
        return [{ method: "item/verification/updated", params: { ...base, verification: event } }];
      case "verification.completed":
        this.verification = event as unknown as Record<string, unknown>;
        return [{ method: "item/verification/updated", params: { ...base, verification: event } }];
      case "plan.updated":
        this.planSteps = event.steps;
        return [{ method: "plan/updated", params: { ...base, steps: event.steps } }];
      case "todo.updated":
        this.todoItems = event.items;
        return [{ method: "todo/updated", params: { ...base, items: event.items } }];
      case "approval.requested":
        return [{ method: "item/approval/requested", params: { ...base, approval: event } }];
      case "approval.resolved":
        return [{ method: "item/approval/resolved", params: { ...base, approval: event } }];
      case "warning":
        return [{ method: "warning", params: { ...base, message: event.message, code: event.code } }];
      case "error":
        return [{ method: "error", params: { ...base, message: event.message, code: event.code } }];
    }
  }

  hydrate(turns: AppTurn[]): void {
    const existingIds = new Set(this.turns.keys());
    const existingFingerprints = new Set(
      [...this.turns.values()]
        .map((entry) => userFingerprint(entry.turn))
        .filter((value): value is string => Boolean(value)),
    );
    const prepend: AppTurn[] = [];
    for (const turn of turns) {
      if (existingIds.has(turn.id)) continue;
      const fingerprint = userFingerprint(turn);
      if (fingerprint && existingFingerprints.has(fingerprint)) continue;
      const cloned = cloneTurn(turn);
      prepend.push(cloned);
      existingIds.add(cloned.id);
      if (fingerprint) existingFingerprints.add(fingerprint);
    }
    if (prepend.length === 0) return;
    const liveEntries = [...this.turns.entries()];
    this.turns.clear();
    for (const turn of prepend) {
      this.turns.set(turn.id, {
        turn,
        items: new Map(turn.items.map((item) => [item.id, item])),
        // Hydrated turns are finished history; nothing further projects into
        // them, so the step counter only has to be well-formed.
        step: 0,
        stepHasTool: false,
        stepProseOpen: false,
      });
    }
    for (const [id, entry] of liveEntries) this.turns.set(id, entry);
  }

  snapshotTurns(): AppTurn[] {
    return [...this.turns.values()].map((entry) => cloneTurn(entry.turn));
  }

  snapshotPlan(): PlanStep[] | undefined {
    return this.planSteps ? structuredClone(this.planSteps) : undefined;
  }

  snapshotTodo(): TodoItem[] | undefined {
    return this.todoItems ? structuredClone(this.todoItems) : undefined;
  }

  snapshotVerification(): Record<string, unknown> | undefined {
    return this.verification ? structuredClone(this.verification) : undefined;
  }

  private ensureTurn(turnId: string): MutableTurn {
    let mutable = this.turns.get(turnId);
    if (!mutable) {
      mutable = {
        turn: { id: turnId, status: "inProgress", items: [] },
        items: new Map(),
        step: 0,
        stepHasTool: false,
        stepProseOpen: false,
      };
      this.turns.set(turnId, mutable);
    }
    return mutable;
  }

  /**
   * Called before any agent prose is projected. If a tool has run since the
   * last prose, the model has been round-tripped, so this opens the next step
   * and the prose gets a fresh id that sorts after those tool calls.
   */
  private beginProseStep(mutable: MutableTurn): void {
    if (!mutable.stepHasTool) return;
    // A message still mid-stream keeps its step even across a tool call: the
    // runner is emitting one model response in pieces, and splitting it would
    // render one sentence as two bubbles either side of the tool.
    if (mutable.stepProseOpen) return;
    mutable.step += 1;
    mutable.stepHasTool = false;
  }

  private putItem(mutable: MutableTurn, item: AppThreadItem): void {
    mutable.items.set(item.id, item);
    mutable.turn.items = [...mutable.items.values()];
  }

  private itemStarted(base: Record<string, unknown>, item: AppThreadItem): ProjectedNotification {
    return { method: "item/started", params: { ...base, item: structuredClone(item) } };
  }

  private itemCompleted(base: Record<string, unknown>, item: AppThreadItem): ProjectedNotification {
    return { method: "item/completed", params: { ...base, item: structuredClone(item) } };
  }

  private turnCompleted(base: Record<string, unknown>, turnId: string, status: AppTurnStatus, error?: string): ProjectedNotification[] {
    const mutable = this.ensureTurn(turnId);
    if (mutable.turn.status === status && !error) return [];
    mutable.turn.status = status;
    if (error) mutable.turn.error = { message: error };
    return [{ method: "turn/completed", params: { ...base, turn: cloneTurn(mutable.turn) } }];
  }
}

/**
 * A projected item by id, without throwing on a miss.
 *
 * The `Map` is keyed by id, so this is the same lookup `get` performs — it
 * exists to make the miss case explicit at the call site, where "no prior row"
 * and "prior row of another type" are the same situation.
 */
function findItem(mutable: MutableTurn, id: string): AppThreadItem | undefined {
  return mutable.items.get(id);
}

/**
 * Add a new measurement to a running total, treating an absent operand as zero.
 *
 * Returns `undefined` only when both sides are absent, which is what lets the
 * caller omit the field entirely: a row for a technique that reports no
 * character count should not claim it saved zero.
 */
function sumField(prior: number | undefined, next: number | undefined): number | undefined {
  if (prior === undefined && next === undefined) return undefined;
  return (prior ?? 0) + (next ?? 0);
}

/**
 * Whether a projected notification may be memoized for its record.
 *
 * Every event except `thread.started` projects from the record alone, so the
 * same sequence always yields the same notifications and caching is safe.
 * `thread.started` embeds the thread's *current* metadata — which changes
 * across the life of a thread — so memoizing it would pin a reconnecting
 * client to the thread as it looked when that event was first sent.
 */
export function isReplayStable(notifications: ProjectedNotification[]): boolean {
  return notifications.every((notification) => notification.method !== "thread/started");
}

export function projectThread(metadata: ThreadMetadata, turns?: AppTurn[]): AppThread {
  // A failed turn's `assistantMessage` is raw error text. Preview is rendered
  // as a thread's label when it has no title, so letting a failure through here
  // puts a stack trace in the sidebar. Only a completed turn contributes one,
  // and an explicit title always wins over it.
  const lastTurn = metadata.lastTurn;
  const turnPreview =
    lastTurn?.status === "completed" && !lastTurn.error ? lastTurn.assistantMessage?.slice(0, 200) : undefined;
  const preview = metadata.title ?? turnPreview ?? "";
  return {
    id: metadata.threadId,
    sessionId: metadata.sessionName,
    preview,
    ephemeral: false,
    cwd: metadata.workspaceRoot,
    ...(metadata.provider ? { modelProvider: metadata.provider } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {}),
    ...(metadata.systemPrompt ? { systemPrompt: metadata.systemPrompt } : {}),
    ...(metadata.disabledTools?.length ? { disabledTools: metadata.disabledTools } : {}),
    approvalPolicy: metadata.permissionMode,
    /*
     * Whether any turn has ever run here. `lastTurn` is written by the first
     * turn and never cleared, so its presence is exactly that question, and a
     * client deciding whether a thread is safe to reuse as a scratch thread
     * needs the answer without paging its transcript.
     */
    hasTurns: metadata.lastTurn !== undefined,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    ...(metadata.title ? { name: metadata.title } : {}),
    status: projectStatus(metadata.status),
    ...(turns ? { turns } : {}),
  };
}

export function projectHistory(messages: SessionMessage[]): AppTurn[] {
  const turns: AppTurn[] = [];
  let current: AppTurn | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      current = {
        id: `history-turn-${turns.length + 1}`,
        status: "completed",
        items: [{
          type: "userMessage",
          id: `history-item-${index + 1}`,
          content: [{ type: "text", text: message.content ?? "" }],
        }],
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: `history-turn-${turns.length + 1}`, status: "completed", items: [] };
      turns.push(current);
    }
    if (message.role === "assistant") {
      current.items.push({
        type: "agentMessage",
        id: `history-item-${index + 1}`,
        text: message.content ?? "",
        phase: "final_answer",
      });
    } else if (message.role === "tool") {
      current.items.push({
        type: "dynamicToolCall",
        id: `history-item-${index + 1}`,
        tool: message.name ?? "tool",
        arguments: {},
        status: "completed",
        result: message.content,
      });
    }
  }
  return turns;
}

function projectStatus(status: string): AppThread["status"] {
  if (status === "running") return { type: "active", activeFlags: ["turn"] };
  if (status === "error") return "systemError";
  if (status === "closed") return "notLoaded";
  return "idle";
}

function toolItem(call: ToolCall, status: "inProgress" | "completed" | "failed"): AppThreadItem {
  if (call.name === "bash") {
    return {
      type: "commandExecution",
      id: call.id,
      command: "cmd" in (call.args as object) && typeof (call.args as { cmd?: unknown }).cmd === "string"
        ? (call.args as { cmd: string }).cmd
        : "",
      status,
    };
  }
  if (["write_file", "edit_file", "file_edit", "apply_patch", "delete_file"].includes(call.name)) {
    const args = asRecord(call.args) ?? {};
    const candidate = args.path ?? args.file_path;
    return {
      type: "fileChange",
      id: call.id,
      changes: typeof candidate === "string" ? [{ path: candidate, kind: call.name }] : [],
      status,
    };
  }
  return { type: "dynamicToolCall", id: call.id, tool: call.name, arguments: asRecord(call.args) ?? {}, status };
}

function completeToolItem(existing: AppThreadItem | undefined, call: ToolCall, result: ToolResult): AppThreadItem {
  const item = existing ?? toolItem(call, result.ok ? "completed" : "failed");
  if (item.type === "commandExecution") {
    item.status = result.ok ? "completed" : "failed";
    const record = asRecord(result.output);
    if (typeof record?.stdout === "string" || typeof record?.stderr === "string") {
      item.aggregatedOutput = `${typeof record.stdout === "string" ? record.stdout : ""}${typeof record.stderr === "string" ? record.stderr : ""}`;
    }
    if (typeof record?.exitCode === "number") item.exitCode = record.exitCode;
  } else if (item.type === "fileChange") {
    item.status = result.ok ? "completed" : "failed";
  } else if (item.type === "dynamicToolCall") {
    item.status = result.ok ? "completed" : "failed";
    item.result = result.output;
    if (result.error?.message) item.error = result.error.message;
  }
  return item;
}

function setItemFailed(item: AppThreadItem, message: string): void {
  if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "dynamicToolCall") item.status = "failed";
  if (item.type === "dynamicToolCall") item.error = message;
}

function cloneTurn(turn: AppTurn): AppTurn {
  return structuredClone(turn);
}

function userFingerprint(turn: AppTurn): string | undefined {
  const item = turn.items.find((entry) => entry.type === "userMessage");
  if (item?.type !== "userMessage") return undefined;
  return item.content.map((part) => part.text).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
