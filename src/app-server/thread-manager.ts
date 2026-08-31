import type { ToolApprovalDecision } from "../tools/approval.js";
import type { ThreadEventSubscriber, ThreadReplay } from "./event-bus.js";
import {
  ManagedReaperThread,
  type ManagedApprovalRequest,
  type ManagedTurnHandle,
  type StartManagedTurnInput,
} from "./managed-thread.js";
import { runManagedTurn, type ManagedTurnRunner, type ManagedTurnRunnerInput } from "./managed-turn-runner.js";
import {
  ThreadStore,
  type CreateThreadMetadataInput,
  type ThreadMetadata,
  type ThreadReadResult,
} from "./thread-store.js";

export interface ReaperThreadManagerOptions {
  dataRoot: string;
  maxConcurrentTurns?: number;
  maxReplayEvents?: number;
  maxSteeringMessages?: number;
  approvalTimeoutMs?: number;
  turnRunner?: ManagedTurnRunner;
  onApprovalRequested?: (request: ManagedApprovalRequest) => void | Promise<void>;
  onApprovalSettled?: (request: ManagedApprovalRequest, decision: ToolApprovalDecision) => void;
}

export class ReaperThreadManager {
  private readonly threads = new Map<string, ManagedReaperThread>();
  private readonly semaphore: AsyncSemaphore;
  private readonly store: ThreadStore;
  private readonly turnRunner: ManagedTurnRunner;
  private shuttingDown = false;

  constructor(private readonly options: ReaperThreadManagerOptions) {
    this.store = new ThreadStore(options.dataRoot);
    this.semaphore = new AsyncSemaphore(options.maxConcurrentTurns ?? 2);
    this.turnRunner = options.turnRunner ?? runManagedTurn;
  }

  async startThread(input: CreateThreadMetadataInput): Promise<ManagedReaperThread> {
    this.assertOpen();
    const metadata = this.store.createMetadata(input);
    if (this.threads.has(metadata.threadId) || await this.store.load(metadata.threadId)) {
      throw new ThreadManagerError("thread_exists", `Thread ${metadata.threadId} already exists`);
    }
    const saved = await this.store.save(metadata);
    const thread = this.createManagedThread(saved);
    this.threads.set(thread.threadId, thread);
    thread.eventBus.publish({ type: "thread.started", threadId: thread.threadId });
    return thread;
  }

  async resumeThread(threadId: string): Promise<ManagedReaperThread> {
    this.assertOpen();
    const live = this.threads.get(threadId);
    if (live) return live;
    const loaded = await this.store.load(threadId);
    if (!loaded) throw new ThreadManagerError("thread_not_found", `Thread ${threadId} was not found`);

    const metadata = loaded.status === "running"
      ? await this.store.save({
          ...loaded,
          status: "idle",
          ...(loaded.lastTurn?.status === "running"
            ? {
                lastTurn: {
                  ...loaded.lastTurn,
                  status: "aborted",
                  completedAt: new Date().toISOString(),
                },
              }
            : {}),
        })
      : loaded;
    const thread = this.createManagedThread(metadata);
    this.threads.set(threadId, thread);
    return thread;
  }

  async getThread(threadId: string): Promise<ManagedReaperThread> {
    return await this.resumeThread(threadId);
  }

  async listThreads(): Promise<ThreadMetadata[]> {
    const stored = await this.store.list();
    const byId = new Map(stored.map((metadata) => [metadata.threadId, metadata]));
    for (const thread of this.threads.values()) byId.set(thread.threadId, thread.metadata);
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readThread(threadId: string): Promise<ThreadReadResult> {
    const thread = this.threads.get(threadId);
    const read = await this.store.read(threadId);
    if (!read) throw new ThreadManagerError("thread_not_found", `Thread ${threadId} was not found`);
    return thread ? { ...read, metadata: thread.metadata } : read;
  }

  async startTurn(threadId: string, input: StartManagedTurnInput): Promise<ManagedTurnHandle> {
    this.assertOpen();
    const thread = await this.resumeThread(threadId);
    return await thread.startTurn(input);
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<boolean> {
    const thread = await this.resumeThread(threadId);
    return thread.interrupt(turnId);
  }

  async steerTurn(threadId: string, turnId: string, message: string): Promise<ReturnType<ManagedReaperThread["steer"]>> {
    const thread = await this.resumeThread(threadId);
    return thread.steer(turnId, message);
  }

  async resolveApproval(threadId: string, approvalId: string, decision: ToolApprovalDecision): Promise<boolean> {
    const thread = await this.resumeThread(threadId);
    return thread.resolveApproval(approvalId, decision);
  }

  async setThreadName(threadId: string, name: string): Promise<ThreadMetadata> {
    const thread = await this.resumeThread(threadId);
    await thread.setName(name);
    return thread.metadata;
  }

  async closeThread(threadId: string): Promise<void> {
    const thread = await this.resumeThread(threadId);
    await thread.close();
  }

  peekThread(threadId: string): ManagedReaperThread | undefined {
    return this.threads.get(threadId);
  }

  async subscribe(
    threadId: string,
    subscriberId: string,
    subscriber: ThreadEventSubscriber,
    afterSequence = 0,
  ): Promise<{ unsubscribe: () => void; replay: ThreadReplay }> {
    const thread = await this.resumeThread(threadId);
    const replay = thread.replayAfter(afterSequence);
    return {
      unsubscribe: thread.subscribe(subscriberId, subscriber),
      replay,
    };
  }

  unsubscribe(threadId: string, subscriberId: string): void {
    this.threads.get(threadId)?.unsubscribe(subscriberId);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const live = [...this.threads.values()];
    for (const thread of live) {
      if (thread.currentTurnId) thread.interrupt(thread.currentTurnId);
    }
    await Promise.all(live.map(async (thread) => {
      const turnId = thread.currentTurnId;
      if (!turnId) return;
      await thread.close().catch(() => undefined);
    }));
  }

  private createManagedThread(metadata: ThreadMetadata): ManagedReaperThread {
    const runWithPermit: ManagedTurnRunner = async (input: ManagedTurnRunnerInput) =>
      await this.semaphore.run(() => this.turnRunner(input), input.abortSignal);
    return new ManagedReaperThread({
      metadata,
      store: this.store,
      runTurn: runWithPermit,
      ...(this.options.maxReplayEvents !== undefined
        ? { maxReplayEvents: this.options.maxReplayEvents }
        : {}),
      ...(this.options.maxSteeringMessages !== undefined
        ? { maxSteeringMessages: this.options.maxSteeringMessages }
        : {}),
      ...(this.options.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: this.options.approvalTimeoutMs }
        : {}),
      ...(this.options.onApprovalRequested
        ? { onApprovalRequested: this.options.onApprovalRequested }
        : {}),
      ...(this.options.onApprovalSettled
        ? { onApprovalSettled: this.options.onApprovalSettled }
        : {}),
    });
  }

  private assertOpen(): void {
    if (this.shuttingDown) {
      throw new ThreadManagerError("server_shutting_down", "The thread manager is shutting down");
    }
  }
}

export class ThreadManagerError extends Error {
  constructor(
    readonly code: "thread_exists" | "thread_not_found" | "server_shutting_down",
    message: string,
  ) {
    super(message);
    this.name = "ThreadManagerError";
  }
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("maxConcurrentTurns must be a positive safe integer");
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return this.createRelease();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abortListener = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.active -= 1;
        return;
      }
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
      waiter.resolve(this.createRelease());
    };
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Operation aborted");
  error.name = "AbortError";
  return error;
}
