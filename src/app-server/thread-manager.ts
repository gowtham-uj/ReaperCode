import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderCredentialStore } from "../config/provider-credentials.js";
import type { ToolApprovalDecision } from "../tools/approval.js";
import type { PermissionMode } from "../policy/classifier.js";
import type { ThreadEventSubscriber, ThreadReplay } from "./event-bus.js";
import {
  ManagedReaperThread,
  type ManagedApprovalRequest,
  type ManagedTurnHandle,
  type StartManagedTurnInput,
} from "./managed-thread.js";
import { runManagedTurn, type ManagedTurnRunner, type ManagedTurnRunnerInput } from "./managed-turn-runner.js";
import type { ThreadBrowsers } from "./thread-browsers.js";
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
  /**
   * The per-thread browser owner, when the server has one.
   *
   * Owned here so it is created once for the server and shared by every thread,
   * rather than each thread reaching for a connection of its own.
   */
  threadBrowsers?: ThreadBrowsers | undefined;
  onApprovalRequested?: (request: ManagedApprovalRequest) => void | Promise<void>;
  onApprovalSettled?: (request: ManagedApprovalRequest, decision: ToolApprovalDecision) => void;
  /** Credential source for turns, so an embedded server reads the home it was
   *  given instead of the developer's real one. */
  credentials?: ProviderCredentialStore;
  /** User-settings home, so a turn's disabled-provider list comes from the
   *  settings file the browser is showing rather than the real one. */
  settingsHome?: string;
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

  async setThreadModel(
    threadId: string,
    provider: string,
    model: string,
  ): Promise<{ metadata: ThreadMetadata; turnInFlight: boolean }> {
    const thread = await this.resumeThread(threadId);
    const outcome = await thread.setModel(provider, model);
    return { metadata: thread.metadata, turnInFlight: outcome.turnInFlight };
  }

  async setThreadPermissionMode(
    threadId: string,
    permissionMode: PermissionMode,
  ): Promise<{ metadata: ThreadMetadata; turnInFlight: boolean }> {
    const thread = await this.resumeThread(threadId);
    const outcome = await thread.setPermissionMode(permissionMode);
    return { metadata: thread.metadata, turnInFlight: outcome.turnInFlight };
  }

  async setThreadReasoningEffort(
    threadId: string,
    reasoningEffort: "low" | "medium" | "high",
  ): Promise<{ metadata: ThreadMetadata; turnInFlight: boolean }> {
    const thread = await this.resumeThread(threadId);
    const outcome = await thread.setReasoningEffort(reasoningEffort);
    return { metadata: thread.metadata, turnInFlight: outcome.turnInFlight };
  }

  async setThreadSystemPrompt(
    threadId: string,
    systemPrompt: string | undefined,
  ): Promise<{ metadata: ThreadMetadata; turnInFlight: boolean }> {
    const thread = await this.resumeThread(threadId);
    const outcome = await thread.setSystemPrompt(systemPrompt);
    return { metadata: thread.metadata, turnInFlight: outcome.turnInFlight };
  }

  async setThreadDisabledTools(
    threadId: string,
    disabledTools: string[],
  ): Promise<{ metadata: ThreadMetadata; turnInFlight: boolean }> {
    const thread = await this.resumeThread(threadId);
    const outcome = await thread.setDisabledTools(disabledTools);
    return { metadata: thread.metadata, turnInFlight: outcome.turnInFlight };
  }

  async setThreadFilesystemSandbox(
    threadId: string,
    enabled: boolean,
  ): Promise<{ metadata: ThreadMetadata; turnInFlight: boolean }> {
    const thread = await this.resumeThread(threadId);
    const outcome = await thread.setFilesystemSandbox(enabled);
    return { metadata: thread.metadata, turnInFlight: outcome.turnInFlight };
  }

  async setThreadName(threadId: string, name: string): Promise<ThreadMetadata> {
    const thread = await this.resumeThread(threadId);
    await thread.setName(name);
    return thread.metadata;
  }

  /**
   * Move an unused thread to a different workspace directory.
   *
   * Rejects threads that have run a turn — see `ManagedReaperThread.
   * setWorkspaceRoot` for why that is a refusal rather than a migration.
   */
  async setThreadWorkspace(threadId: string, workspaceRoot: string): Promise<ThreadMetadata> {
    const thread = await this.resumeThread(threadId);
    await thread.setWorkspaceRoot(workspaceRoot);
    return thread.metadata;
  }

  async closeThread(threadId: string): Promise<void> {
    const thread = await this.resumeThread(threadId);
    await thread.close();
  }

  /**
   * Delete a thread and everything it owned.
   *
   * Distinct from `closeThread`, which only stops it: a closed thread can be
   * resumed and still owns its browser pages, its cookies and its downloaded
   * files. Deleting is for a conversation the user is done with, and leaving any
   * of that behind is how a shared browser fills up with tabs nobody can see and
   * a workspace fills up with directories nothing references.
   *
   * What is removed, in the order it has to happen:
   *
   *   1. the browser, which releases its pages and its ownership record. This is
   *      first because a page that outlives its thread is a page no thread can
   *      claim, and the shared context would keep it until Chrome restarts.
   *   2. the thread record, which is what `listThreads` reads.
   *   3. the conversation journal.
   *   4. the thread's own workspace directory, when it had one of its own. The
   *      check is deliberate: a thread whose workspace is a directory the user
   *      chose (`/work`, a repo) must not have that directory deleted, only the
   *      `.reaper` state inside it.
   */
  async deleteThread(threadId: string): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    /*
     * The browser first, and by thread id rather than through a runtime, because
     * the runtime may not exist after a restart while the disk state does.
     */
    await this.options.threadBrowsers?.closeThread(threadId).catch(() => undefined);
    removed.push(...await closeThreadDiskState(this.store.pathFor(threadId)));
    await this.store.delete(threadId).then(() => removed.push("thread-record")).catch(() => undefined);
    this.threads.delete(threadId);
    return { removed };
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
      ...(this.options.threadBrowsers ? { threadBrowsers: this.options.threadBrowsers } : {}),
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
      // Threaded through so a turn resolves credentials from the home this
      // server was configured with, rather than from the real one.
      ...(this.options.credentials ? { credentials: this.options.credentials } : {}),
      ...(this.options.settingsHome ? { settingsHome: this.options.settingsHome } : {}),
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

/**
 * Remove the files one thread left on disk.
 *
 * Beside its record, a thread owns a browser state file, a page-ownership
 * record, a saved page list, an IndexedDB snapshot and a directory of downloads.
 * They are named after the record rather than kept in a registry, so they are
 * found by prefix, which is also why deleting the record alone would leave them
 * behind as files nothing will ever read again.
 *
 * A thread's journal lives in its own workspace and is removed by the caller
 * that knows where that is; this only handles the state under `.reaper`.
 */
async function closeThreadDiskState(recordPath: string): Promise<string[]> {
  const removed: string[] = [];
  const browserDir = join(dirname(dirname(dirname(recordPath))), "browser");
  const threadId = recordPath.slice(recordPath.lastIndexOf("/") + 1).replace(/\.json$/, "");
  /*
   * Every file whose name begins with the thread id: the state file, and the
   * three suffixes that sit beside it. Matched by prefix because that is how they
   * are written, so a new sibling added later is cleaned up without this list
   * having to know about it.
   */
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(browserDir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(threadId)) continue;
    const target = join(browserDir, name);
    /*
     * A directory here is the thread's download vault, and it is only removed
     * when it is the vault: a name that matches the thread id but is a directory
     * for any other reason is left alone rather than recursively deleted.
     */
    const info = await stat(target).catch(() => undefined);
    if (info?.isDirectory() && name !== threadId) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await rm(target, { force: true }).catch(() => undefined);
    }
    removed.push(name);
  }
  return removed;
}
