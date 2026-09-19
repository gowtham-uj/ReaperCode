import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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

  /**
   * Remove workspace directories whose thread no longer exists.
   *
   * `deleteThread` cleans up after itself, and this covers everything it cannot:
   * a thread deleted by another process or an older build, a crash midway through
   * a delete, or a server killed between removing the record and removing the
   * directory. The record is the source of truth for existence, so a directory
   * under the managed root with no record beside it is garbage by definition.
   *
   * Measured: after a purge from a script, thirteen empty workspace directories
   * were left on disk that nothing would ever reference or remove. Only the
   * managed root is swept: a directory the user chose is never touched, because
   * it is their code and not a workspace the app minted.
   *
   * Best effort. A sweep that cannot read the directory or cannot remove one
   * entry leaves the rest alone rather than failing the boot.
   */
  async sweepOrphanWorkspaces(): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    const root = join(homedir(), ".reaper", "workspaces");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    /*
     * Every workspace path a live thread is using, resolved.
     *
     * Matched by path rather than by directory name, and that distinction was a
     * bug the tests caught: the first version compared names to thread ids, which
     * holds only for a workspace the app minted. A thread pointed at
     * `<root>/<anything>` is a live thread whose directory name has nothing to do
     * with its id, so the sweep deleted a workspace out from under it. The record
     * holds the path, so the path is what is compared.
     */
    const livePaths = new Set(
      (await this.store.list())
        .map((metadata) => metadata.workspaceRoot)
        .filter((workspace): workspace is string => typeof workspace === "string" && workspace.length > 0)
        .map((workspace) => resolve(workspace)),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = join(root, entry.name);
      if (livePaths.has(resolve(target))) continue;
      /*
       * A directory holding a conversation is never deleted by this pass.
       *
       * This is the guard for a failure that really happened: a thread's record
       * survived on disk while its workspace was gone, so the sidebar showed a
       * conversation whose every turn had been destroyed and which could never be
       * opened again. Deleting a conversation is the worst outcome available
       * here, and it is irreversible, while leaving one directory behind costs
       * disk and nothing else.
       *
       * The session journal is what makes a directory a conversation rather than
       * scratch. Its presence means a thread read or wrote turns in this
       * workspace, so whatever the record says, there is something here worth
       * keeping, and a sweep whose whole job is housekeeping has no business
       * being the thing that loses it. If a record was genuinely deleted then
       * `deleteThread` already removed the workspace by name, so this does not
       * resurrect anything a user asked to remove.
       */
      const sessions = join(target, ".reaper", "sessions");
      const held = await readdir(sessions).catch(() => [] as string[]);
      if (held.length > 0) continue;
      /*
       * Only remove a directory that is certainly ours.
       *
       * Two shapes qualify. An empty one is the scaffolding `createThreadWorkspace`
       * makes for a thread that then ran nothing, and removing it loses nothing.
       * A populated one carries the `.reaper` directory the app writes into every
       * workspace it makes, which is the marker that says "the app has been
       * here". A directory with content and no such marker is left alone: it is
       * something a person put here, and it is not this pass's to delete.
       */
      const marker = join(target, ".reaper");
      const hasMarker = await stat(marker).then((info) => info.isDirectory()).catch(() => false);
      if (!hasMarker) {
        const contents = await readdir(target).catch(() => undefined);
        if (contents === undefined || contents.length > 0) continue;
      }
      await rm(target, { recursive: true, force: true })
        .then(() => removed.push(entry.name))
        .catch(() => undefined);
    }
    return { removed };
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

  /**
   * Every thread that still exists, newest first.
   *
   * The record on disk decides existence, and the in-memory entry only supplies
   * fresher metadata for a thread that still has one. This was a plain merge of
   * the two, which listed dead threads: a thread deleted by another process (the
   * CLI, a second server, a cleanup script) left this process's map holding it
   * forever, so the sidebar showed a row for a conversation whose record, files
   * and browser pages were all gone. Measured: after a purge, the live UI still
   * rendered one row for a thread that no longer existed anywhere, and clicking
   * delete on it did nothing because there was nothing left to delete.
   *
   * A live entry with no record is dropped from the map as well as from the list,
   * because it can never become valid again: nothing recreates a record under the
   * same id.
   */
  /**
   * Whether a thread has a turn in flight, answered without touching disk.
   *
   * Synchronous on purpose: the browser reaper asks this on a timer for every
   * thread it holds, and a question that can be answered from memory must not
   * become a file read. Only a thread already in memory can be mid-turn, so an
   * absent entry is an honest `false`.
   */
  isThreadRunning(threadId: string): boolean {
    return this.threads.get(threadId)?.isRunning === true;
  }

  /**
   * The ids of the threads that still exist, from the records on disk.
   *
   * Disk rather than the in-memory map, because the sweep's question is about
   * ownership files that outlive a process: after a restart the map is empty
   * while the records are not, and a sweep that trusted the map would treat
   * every surviving thread's pages as orphans and close them.
   *
   * This is the answer the orphan sweep needs to tell a real claim from litter,
   * and the reason it is a method here rather than a field somewhere is that the
   * record store is the only thing that knows.
   */
  async liveThreadIds(): Promise<ReadonlySet<string>> {
    const stored = await this.store.list();
    return new Set(stored.map((metadata) => metadata.threadId));
  }

  /**
   * Where a thread's files live, from memory.
   *
   * Synchronous because the browser runtime asks during construction: the
   * download vault lives inside the workspace, so the value is needed before the
   * object exists. Only a resident thread is asked about, and a thread with no
   * record yet gets `undefined`, which the vault treats as "no workspace".
   */
  workspaceFor(threadId: string): string | undefined {
    return this.threads.get(threadId)?.metadata.workspaceRoot;
  }

  async listThreads(): Promise<ThreadMetadata[]> {
    const stored = await this.store.list();
    const onDisk = new Set(stored.map((metadata) => metadata.threadId));
    const byId = new Map(stored.map((metadata) => [metadata.threadId, metadata]));
    for (const thread of [...this.threads.values()]) {
      if (!onDisk.has(thread.threadId)) {
        this.threads.delete(thread.threadId);
        continue;
      }
      byId.set(thread.threadId, thread.metadata);
    }
    /*
     * A thread whose own workspace was destroyed is not listed.
     *
     * This is the other half of the zombie failure: the record survived on disk
     * while its workspace, and with it the whole conversation, was destroyed. The
     * sidebar showed it, clicking it opened nothing, and there was no way to
     * remove it because every action failed the same way. A row that cannot be
     * opened is worse than a missing row: a missing row is honest, and this one
     * asks the reader to keep trying.
     *
     * Scoped to a workspace the app minted, and the scope is the safety property.
     * An app-managed path under our own root is one we created and would have
     * kept, so its absence means the thread is genuinely gone. A workspace the
     * user chose is left alone however it looks: `/work`, a repository, a path
     * they typed. Reporting those on the strength of a `stat` would hide a
     * conversation over a missing mount, a renamed checkout, or a typo, and
     * hiding somebody's work is worse than showing a row that needs one more
     * attempt.
     */
    const alive: ThreadMetadata[] = [];
    for (const metadata of byId.values()) {
      const root = metadata.workspaceRoot;
      if (root === undefined || root.length === 0) {
        alive.push(metadata);
        continue;
      }
      if (!isAppManagedWorkspace(root)) {
        alive.push(metadata);
        continue;
      }
      const present = await stat(root).then(() => true).catch(() => false);
      if (present) alive.push(metadata);
      else this.threads.delete(metadata.threadId);
    }
    return alive.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
     * Read the metadata before removing anything, because the workspace path is
     * only in the record and it is needed for the two steps at the end.
     */
    const metadata = await this.store.load(threadId);
    /*
     * The browser first, and by thread id rather than through a runtime, because
     * the runtime may not exist after a restart while the disk state does.
     */
    await this.options.threadBrowsers?.closeThread(threadId).catch(() => undefined);
    removed.push(...await closeThreadDiskState(this.store.pathFor(threadId)));
    await this.store.delete(threadId).then(() => removed.push("thread-record")).catch(() => undefined);
    /*
     * A sweep right after the records are gone.
     *
     * `closeThread` closes the pages this thread's record names, but a page that
     * was never recorded (opened in a step that did not reach a save) is an
     * orphan the moment the record disappears, and the only thing that can find
     * it is a pass that compares the browser against every remaining record.
     * Waiting for the timer would leave it for up to five minutes, which during a
     * delete-heavy cleanup is how the accumulation happens.
     */
    void this.options.threadBrowsers?.sweepOrphans().catch(() => undefined);
    void this.sweepOrphanWorkspaces().catch(() => undefined);
    this.threads.delete(threadId);

    /*
     * The thread's own workspace, when the app created it.
     *
     * This was missing, and the user's requirement is explicit: deleting a thread
     * removes it, its pages, its resources and its session too. Measured before
     * the fix: the record, the browser state and the ownership file all went, and
     * the workspace directory and its whole session journal stayed on disk
     * forever. A user clearing fifty threads was left with fifty directories.
     *
     * The check is what keeps this from being dangerous. A thread whose workspace
     * is a directory the user chose (`/work`, a repository, anything they typed)
     * must not have that directory deleted: it holds their code, not ours. Only a
     * path the app itself minted, under its own managed workspaces root, is
     * removed, and only when it is a strict child of that root rather than the
     * root itself.
     */
    const workspace = metadata?.workspaceRoot;
    if (workspace !== undefined && workspace.length > 0) {
      if (isAppManagedWorkspace(workspace)) {
        /*
         * The whole directory, because the app created it for this thread alone.
         * It holds the sandbox the thread's commands ran in, the files the agent
         * wrote, the download vault, and the session journal under `.reaper`.
         * Nothing else references it once the record is gone, so it is the
         * thread's sandbox and the thread's resources together.
         */
        await rm(workspace, { recursive: true, force: true })
          .then(() => removed.push("workspace"))
          .catch(() => undefined);
      } else {
        /*
         * A directory the user chose (`/work`, a repository) keeps its contents,
         * because they are the user's code and not ours to delete. What goes is
         * the thread's own state inside it: the session journal and the session
         * name directory beside it, which is the conversation and how it is
         * resumed, and nothing else reads once the thread is gone.
         */
        for (const target of [
          join(workspace, ".reaper", "sessions", `app-${threadId}`),
          join(workspace, ".reaper", "sessions", threadId),
        ]) {
          await rm(target, { recursive: true, force: true })
            .then(() => removed.push(`session:${threadId}`))
            .catch(() => undefined);
        }
      }
    }
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
 * Whether a workspace path is one the app minted for a thread.
 *
 * The rule is a strict child of the managed workspaces root, `<home>/.reaper/
 * workspaces/<id>`, which is where `createThreadWorkspace` puts a thread that
 * was not given a directory. A strict child and not the root, because a thread
 * pointed at `<home>/.reaper/workspaces` itself is a user-chosen directory and
 * deleting it would take every other thread's workspace with it.
 *
 * Paths are compared after resolution so `.` and trailing separators cannot
 * disguise a directory as one of ours.
 */
function isAppManagedWorkspace(workspaceRoot: string): boolean {
  const root = join(homedir(), ".reaper", "workspaces");
  const target = resolve(workspaceRoot);
  const base = resolve(root);
  if (target === base) return false;
  /*
   * A separator is appended before the prefix test, so a sibling directory whose
   * name merely starts with the same characters (`/x/workspaces-other`) is not
   * mistaken for a child of `/x/workspaces`.
   */
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
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
