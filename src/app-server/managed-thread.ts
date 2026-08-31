import { randomUUID } from "node:crypto";

import { RuntimeTurnControl, type RuntimeEvent } from "../runtime/events.js";
import type { ToolApprovalDecision, ToolApprovalRequest, ToolApprovalRequester } from "../tools/approval.js";
import { ThreadEventBus, type ThreadEventSubscriber, type ThreadReplay } from "./event-bus.js";
import type { ManagedTurnRunner, ManagedTurnRunnerInput } from "./managed-turn-runner.js";
import { ThreadStore, type ManagedTurnStatus, type ThreadMetadata } from "./thread-store.js";

export interface ManagedTurnSummary {
  threadId: string;
  turnId: string;
  status: Exclude<ManagedTurnStatus, "running">;
  assistantMessage: string;
  startedAt: string;
  completedAt: string;
  error?: { name: string; message: string };
}

export interface ManagedTurnHandle {
  threadId: string;
  turnId: string;
  completion: Promise<ManagedTurnSummary>;
}

export interface StartManagedTurnInput {
  prompt: string;
  turnId?: string;
}

export interface ManagedApprovalRequest extends ToolApprovalRequest {
  threadId: string;
  turnId: string;
}

export interface ManagedThreadOptions {
  metadata: ThreadMetadata;
  store: ThreadStore;
  runTurn: ManagedTurnRunner;
  maxReplayEvents?: number;
  maxSteeringMessages?: number;
  approvalTimeoutMs?: number;
  onApprovalRequested?: (request: ManagedApprovalRequest) => void | Promise<void>;
}

interface ActiveTurn {
  turnId: string;
  startedAt: string;
  abortController: AbortController;
  control: RuntimeTurnControl;
  completion: Promise<ManagedTurnSummary>;
}

interface PendingApproval {
  request: ManagedApprovalRequest;
  resolve: (decision: ToolApprovalDecision) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export class ManagedReaperThread implements ToolApprovalRequester {
  private metadataValue: ThreadMetadata;
  private activeTurn: ActiveTurn | undefined;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private persistChain: Promise<void> = Promise.resolve();
  readonly eventBus: ThreadEventBus;

  constructor(private readonly options: ManagedThreadOptions) {
    this.metadataValue = options.metadata;
    this.eventBus = new ThreadEventBus(
      options.metadata.threadId,
      options.maxReplayEvents ?? 2_000,
    );
  }

  get metadata(): ThreadMetadata {
    return structuredClone(this.metadataValue);
  }

  get threadId(): string {
    return this.metadataValue.threadId;
  }

  get currentTurnId(): string | undefined {
    return this.activeTurn?.turnId;
  }

  get isRunning(): boolean {
    return Boolean(this.activeTurn);
  }

  get pendingApprovalIds(): string[] {
    return [...this.pendingApprovals.keys()];
  }

  async startTurn(input: StartManagedTurnInput): Promise<ManagedTurnHandle> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new ManagedThreadError("invalid_prompt", "Turn prompt is required");
    if (this.metadataValue.status === "closed") {
      throw new ManagedThreadError("thread_closed", `Thread ${this.threadId} is closed`);
    }
    if (this.activeTurn) {
      throw new ManagedThreadError("turn_in_progress", `Thread ${this.threadId} already has an active turn`);
    }

    const turnId = input.turnId ?? `turn-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const abortController = new AbortController();
    const control = new RuntimeTurnControl(this.options.maxSteeringMessages ?? 32);
    let resolveCompletion!: (summary: ManagedTurnSummary) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<ManagedTurnSummary>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const active: ActiveTurn = {
      turnId,
      startedAt,
      abortController,
      control,
      completion,
    };
    this.activeTurn = active;
    this.metadataValue = {
      ...this.metadataValue,
      status: "running",
      lastTurn: { turnId, status: "running", startedAt },
    };
    await this.persist();
    this.eventBus.publish({ type: "turn.queued", threadId: this.threadId, turnId }, turnId);
    this.eventBus.publish({ type: "turn.user.message", threadId: this.threadId, turnId, text: prompt }, turnId);
    this.eventBus.publish({ type: "thread.status.changed", threadId: this.threadId, status: "running" }, turnId);

    void this.executeTurn(active, prompt).then(resolveCompletion, rejectCompletion);
    return { threadId: this.threadId, turnId, completion };
  }

  steer(turnId: string, message: string): ReturnType<RuntimeTurnControl["steer"]> {
    if (!this.activeTurn || this.activeTurn.turnId !== turnId) {
      return { accepted: false, reason: "closed" };
    }
    return this.activeTurn.control.steer(message);
  }

  interrupt(turnId?: string): boolean {
    const active = this.activeTurn;
    if (!active || (turnId && active.turnId !== turnId)) return false;
    this.eventBus.publish(
      { type: "turn.interrupt.requested", threadId: this.threadId, turnId: active.turnId },
      active.turnId,
    );
    active.control.close();
    this.cancelPendingApprovals("cancelled");
    active.abortController.abort(new Error("Turn interrupted"));
    return true;
  }

  async setName(name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized) throw new ManagedThreadError("invalid_prompt", "Thread name is required");
    this.metadataValue = { ...this.metadataValue, title: normalized };
    await this.persist();
  }

  async close(): Promise<void> {
    if (this.metadataValue.status === "closed") return;
    const active = this.activeTurn;
    if (active) {
      this.interrupt(active.turnId);
      await Promise.race([
        active.completion.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]);
    }
    this.cancelPendingApprovals("cancelled");
    this.metadataValue = { ...this.metadataValue, status: "closed" };
    await this.persist();
    this.eventBus.publish({ type: "thread.closed", threadId: this.threadId });
    this.eventBus.publish({ type: "thread.status.changed", threadId: this.threadId, status: "closed" });
  }

  subscribe(subscriberId: string, subscriber: ThreadEventSubscriber): () => void {
    return this.eventBus.subscribe(subscriberId, subscriber);
  }

  unsubscribe(subscriberId: string): void {
    this.eventBus.unsubscribe(subscriberId);
  }

  replayAfter(sequence = 0): ThreadReplay {
    return this.eventBus.replayAfter(sequence);
  }

  async requestApproval(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
    const active = this.activeTurn;
    if (!active || active.abortController.signal.aborted) return "cancelled";
    if (signal?.aborted) return "cancelled";
    if (this.pendingApprovals.has(request.approvalId)) {
      throw new Error(`Duplicate approval ID: ${request.approvalId}`);
    }

    const managedRequest: ManagedApprovalRequest = {
      ...request,
      threadId: this.threadId,
      turnId: active.turnId,
    };

    return await new Promise<ToolApprovalDecision>((resolve) => {
      const settle = (decision: ToolApprovalDecision): void => {
        const pending = this.pendingApprovals.get(request.approvalId);
        if (!pending) return;
        this.pendingApprovals.delete(request.approvalId);
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.signal && pending.abortListener) {
          pending.signal.removeEventListener("abort", pending.abortListener);
        }
        resolve(decision);
      };
      const abortListener = (): void => settle("cancelled");
      const timeoutMs = this.options.approvalTimeoutMs ?? 120_000;
      const pending: PendingApproval = {
        request: managedRequest,
        resolve: settle,
        ...(signal ? { signal, abortListener } : {}),
        ...(timeoutMs > 0
          ? { timer: (() => {
              const timer = setTimeout(() => settle("timeout"), timeoutMs);
              timer.unref();
              return timer;
            })() }
          : {}),
      };
      this.pendingApprovals.set(request.approvalId, pending);
      signal?.addEventListener("abort", abortListener, { once: true });

      try {
        const result = this.options.onApprovalRequested?.(managedRequest);
        if (result && typeof result.then === "function") {
          void result.catch(() => settle("cancelled"));
        }
      } catch {
        settle("cancelled");
      }
    });
  }

  resolveApproval(approvalId: string, decision: ToolApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
  }

  cancelPendingApprovals(decision: Extract<ToolApprovalDecision, "cancelled" | "timeout" | "denied"> = "cancelled"): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.resolve(decision);
    }
  }

  private async executeTurn(active: ActiveTurn, prompt: string): Promise<ManagedTurnSummary> {
    const runnerInput: ManagedTurnRunnerInput = {
      threadId: this.threadId,
      turnId: active.turnId,
      sessionName: this.metadataValue.sessionName,
      workspaceRoot: this.metadataValue.workspaceRoot,
      prompt,
      ...(this.metadataValue.provider ? { provider: this.metadataValue.provider } : {}),
      ...(this.metadataValue.model ? { model: this.metadataValue.model } : {}),
      permissionMode: this.metadataValue.permissionMode,
      abortSignal: active.abortController.signal,
      eventSink: (event: RuntimeEvent) => {
        this.eventBus.publish(event, active.turnId);
      },
      turnControl: active.control,
      approvalRequester: this,
    };

    try {
      const result = await this.options.runTurn(runnerInput);
      const status = active.abortController.signal.aborted ? "aborted" : "completed";
      return await this.finishTurn(active, {
        status,
        assistantMessage: result.assistantMessage ?? "",
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (active.abortController.signal.aborted || normalized.name === "AbortError") {
        return await this.finishTurn(active, { status: "aborted", assistantMessage: "" });
      }
      return await this.finishTurn(active, {
        status: "failed",
        assistantMessage: "",
        error: { name: normalized.name, message: normalized.message },
      });
    }
  }

  private async finishTurn(
    active: ActiveTurn,
    result: {
      status: Exclude<ManagedTurnStatus, "running">;
      assistantMessage: string;
      error?: { name: string; message: string };
    },
  ): Promise<ManagedTurnSummary> {
    const completedAt = new Date().toISOString();
    active.control.close();
    this.cancelPendingApprovals("cancelled");
    if (this.activeTurn === active) this.activeTurn = undefined;

    const summary: ManagedTurnSummary = {
      threadId: this.threadId,
      turnId: active.turnId,
      status: result.status,
      assistantMessage: result.assistantMessage,
      startedAt: active.startedAt,
      completedAt,
      ...(result.error ? { error: result.error } : {}),
    };
    this.metadataValue = {
      ...this.metadataValue,
      status: result.status === "failed" ? "error" : "idle",
      lastTurn: {
        turnId: active.turnId,
        status: result.status,
        startedAt: active.startedAt,
        completedAt,
        ...(result.assistantMessage ? { assistantMessage: result.assistantMessage } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    };
    await this.persist();
    if (result.status === "completed") {
      this.eventBus.publish({
        type: "turn.completed",
        runId: active.turnId,
        sessionId: this.threadId,
        assistantMessage: result.assistantMessage,
        timestamp: completedAt,
      }, active.turnId);
    } else if (result.status === "aborted") {
      this.eventBus.publish({
        type: "turn.aborted",
        runId: active.turnId,
        sessionId: this.threadId,
        reason: result.error?.message ?? "interrupted",
        timestamp: completedAt,
      }, active.turnId);
    } else {
      this.eventBus.publish({
        type: "turn.failed",
        runId: active.turnId,
        sessionId: this.threadId,
        error: result.error ?? { name: "Error", message: "Turn failed" },
        timestamp: completedAt,
      }, active.turnId);
    }
    this.eventBus.publish({
      type: "thread.status.changed",
      threadId: this.threadId,
      status: this.metadataValue.status,
    }, active.turnId);
    return summary;
  }

  private async persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      this.metadataValue = await this.options.store.save(this.metadataValue);
    });
    await this.persistChain;
  }
}

export class ManagedThreadError extends Error {
  constructor(readonly code: "invalid_prompt" | "thread_closed" | "turn_in_progress", message: string) {
    super(message);
    this.name = "ManagedThreadError";
  }
}
