import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { RuntimeTurnControl, type RuntimeEvent } from "../runtime/events.js";
import { isStoppedShortBlocker } from "../runtime/engine.js";
import type { PermissionMode } from "../policy/classifier.js";
import type { ToolApprovalDecision, ToolApprovalRequest, ToolApprovalRequester } from "../tools/approval.js";
import { ThreadEventBus, type ThreadEventSubscriber, type ThreadReplay } from "./event-bus.js";
import type { ManagedTurnRunner, ManagedTurnRunnerInput } from "./managed-turn-runner.js";
import type { ThreadBrowsers } from "./thread-browsers.js";
import type { ProviderCredentialStore } from "../config/provider-credentials.js";
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
  /**
   * The server's per-thread browser owner, when there is one.
   *
   * Absent in tests, which is why every browser-dependent test constructs its own
   * runtime: a test that needs a browser should say so rather than depending on a
   * server having started one.
   */
  threadBrowsers?: ThreadBrowsers | undefined;
  maxReplayEvents?: number;
  maxSteeringMessages?: number;
  approvalTimeoutMs?: number;
  onApprovalRequested?: (request: ManagedApprovalRequest) => void | Promise<void>;
  /**
   * Fired whenever a pending approval settles, including from the internal
   * timeout and abort paths that no client ever hears about otherwise.
   * Without this a reviewer is left showing an approval prompt that the agent
   * has already stopped waiting on.
   */
  onApprovalSettled?: (request: ManagedApprovalRequest, decision: ToolApprovalDecision) => void;
  /**
   * Where credentials are read from, passed down to the turn runner.
   *
   * Carried through the thread rather than re-created per turn so a server
   * configured with an explicit home reads keys from that home. Without it the
   * turn runner built its own store rooted at the real `~/.reaper`, and a
   * server pointed elsewhere authenticated with credentials it was never given.
   */
  credentials?: ProviderCredentialStore;
  /**
   * Where user settings are read from, passed down to the turn runner so its
   * disabled-provider list matches the one the browser is showing. Same
   * reasoning as `credentials`: the home the server was configured with decides
   * which settings file it reads.
   */
  settingsHome?: string;
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
    // Publish `turn.user.message` when the engine actually drains a steered
    // message — the moment the model sees it — rather than when the client
    // steers. Steering accepted early would otherwise claim delivery early.
    const control = new RuntimeTurnControl(
      this.options.maxSteeringMessages ?? 32,
      (messages) => {
        for (const message of messages) {
          this.eventBus.publish(
            { type: "turn.user.message", threadId: this.threadId, turnId, text: message },
            turnId,
          );
        }
      },
    );
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
    // The `turn.user.message` event is published from the control's drain hook,
    // not here: acceptance only means "queued", and showing the message in the
    // transcript at that point claims the agent has it when it does not.
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

  /**
   * Point this thread at a different directory.
   *
   * Refused once a turn has run, because the workspace is not just a setting —
   * it is half of the transcript's address (`<workspaceRoot>/.reaper/sessions/
   * <sessionName>/session.jsonl`) and the root every sandboxed tool call
   * resolves against. Moving a thread with history would strand its journal at
   * the old path and make every file the conversation refers to unreachable,
   * so the honest answer is to refuse rather than to half-move it.
   *
   * An unused thread has neither problem: there is no journal yet and no file
   * the user has seen, so this is the same operation as having chosen the
   * directory at creation time.
   */
  async setWorkspaceRoot(workspaceRoot: string): Promise<void> {
    const normalized = workspaceRoot.trim();
    if (!normalized) throw new ManagedThreadError("invalid_prompt", "A workspace directory is required");
    if (this.metadataValue.lastTurn) {
      throw new ManagedThreadError(
        "turn_in_progress",
        "This thread already has conversation history. Its workspace cannot change — start a new thread for a different directory.",
      );
    }
    const resolved = path.resolve(normalized);
    if (resolved === this.metadataValue.workspaceRoot) return;
    await mkdir(resolved, { recursive: true });
    this.metadataValue = { ...this.metadataValue, workspaceRoot: resolved };
    await this.persist();
  }

  /**
   * Point this thread at a different provider/model.
   *
   * Returns whether a turn was running, because that determines when the change
   * bites. `executeTurn` snapshots `provider`/`model` off the metadata when it
   * builds the turn's config, so a running turn keeps the model it started
   * with and the next one picks this up. Mutating a live turn's model instead
   * would splice two models' output into a single transcript with no record of
   * the boundary.
   */
  async setModel(provider: string, model: string): Promise<{ turnInFlight: boolean }> {
    const normalizedProvider = provider.trim();
    const normalizedModel = model.trim();
    if (!normalizedProvider || !normalizedModel) {
      throw new ManagedThreadError("invalid_prompt", "provider and model are required");
    }
    this.metadataValue = { ...this.metadataValue, provider: normalizedProvider, model: normalizedModel };
    await this.persist();
    return { turnInFlight: this.activeTurn !== undefined };
  }

  /**
   * Change this thread's permission mode. Same appliesTo semantics as
   * `setModel`: a turn already running snapshots the mode when it builds its
   * runner config, so this bites at the next turn.
   */
  async setPermissionMode(permissionMode: PermissionMode): Promise<{ turnInFlight: boolean }> {
    this.metadataValue = { ...this.metadataValue, permissionMode };
    await this.persist();
    return { turnInFlight: this.activeTurn !== undefined };
  }

  /** Change the real provider reasoning knob used by the next model request. */
  async setReasoningEffort(reasoningEffort: "low" | "medium" | "high"): Promise<{ turnInFlight: boolean }> {
    this.metadataValue = { ...this.metadataValue, reasoningEffort };
    await this.persist();
    return { turnInFlight: this.activeTurn !== undefined };
  }

  /**
   * Replace this thread's extra instructions. Passing `undefined` clears them,
   * which is a different state from an empty string only in how it is stored.
   *
   * `exactOptionalPropertyTypes` is on, so an explicit `undefined` cannot be
   * assigned over an optional property — the key has to be dropped instead.
   */
  async setSystemPrompt(systemPrompt: string | undefined): Promise<{ turnInFlight: boolean }> {
    const trimmed = systemPrompt?.trim();
    const { systemPrompt: _cleared, ...rest } = this.metadataValue;
    this.metadataValue = trimmed ? { ...rest, systemPrompt: trimmed } : rest;
    await this.persist();
    return { turnInFlight: this.activeTurn !== undefined };
  }

  /**
   * Set which tools this thread may not call. Sorted and de-duplicated so the
   * saved value is stable — otherwise re-saving the same set would rewrite the
   * metadata file and bump `updatedAt`, which reorders the sidebar.
   */
  async setDisabledTools(disabledTools: string[]): Promise<{ turnInFlight: boolean }> {
    const unique = [...new Set(disabledTools.map((name) => name.trim()).filter(Boolean))].sort();
    const { disabledTools: _cleared, ...rest } = this.metadataValue;
    this.metadataValue = unique.length > 0 ? { ...rest, disabledTools: unique } : rest;
    await this.persist();
    return { turnInFlight: this.activeTurn !== undefined };
  }

  /**
   * Turn this thread's workspace confinement on or off.
   *
   * Unlike the model and prompt settings, this one is not snapshotted at the
   * start of a turn: `executeTurn` reads the metadata when it builds the
   * runner input, and the runner passes it to the executor, which reads it
   * again for every command. So a turn already running picks the new value up
   * at its next shell call rather than at its next turn, which is what the
   * setting has to mean to be worth having — a thread doing something
   * unexpected is exactly the thread you want to confine now.
   */
  async setFilesystemSandbox(enabled: boolean): Promise<{ turnInFlight: boolean }> {
    this.metadataValue = { ...this.metadataValue, filesystemSandbox: enabled };
    await this.persist();
    return { turnInFlight: this.activeTurn !== undefined };
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
        try {
          this.options.onApprovalSettled?.(managedRequest, decision);
        } catch {
          // A misbehaving observer must not stop the agent from proceeding.
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
      ...(this.metadataValue.reasoningEffort ? { reasoningEffort: this.metadataValue.reasoningEffort } : {}),
      ...(this.metadataValue.systemPrompt ? { systemPrompt: this.metadataValue.systemPrompt } : {}),
      ...(this.metadataValue.disabledTools?.length
        ? { disabledTools: this.metadataValue.disabledTools }
        : {}),
      permissionMode: this.metadataValue.permissionMode,
      filesystemSandbox: this.metadataValue.filesystemSandbox !== false,
      abortSignal: active.abortController.signal,
      eventSink: (event: RuntimeEvent) => {
        this.eventBus.publish(event, active.turnId);
      },
      turnControl: active.control,
      approvalRequester: this,
      ...(this.options.credentials ? { credentials: this.options.credentials } : {}),
      ...(this.options.settingsHome ? { settingsHome: this.options.settingsHome } : {}),
      /*
       * The thread's own browser, resolved per turn rather than captured once.
       *
       * Resolved here because the owner is keyed by thread id and this is the
       * place that knows it. Handing over the runtime rather than a connection
       * means a thread that has been idle past the reap window gets a fresh
       * attachment on its next turn without anything above knowing that happened.
       */
      ...(this.options.threadBrowsers ? { threadBrowser: this.options.threadBrowsers.forThread(this.threadId) } : {}),
      /*
       * An error that escapes this turn cancels this turn, and only this turn.
       *
       * The engine's crash handler calls this instead of exiting the process
       * when the fault belongs to a run. Aborting the turn is what makes the
       * failure recoverable: `executeTurn` below sees the aborted signal, closes
       * the turn as aborted, and the thread is left ready for the next message.
       * Every other thread, the gateway and the UI are untouched, and the
       * browser keeps its pages because nothing here closes them.
       */
      onRunFault: (error, cause) => {
        /*
         * Logged, not published as an event: the abort below already closes the
         * turn as aborted, and `executeTurn`'s catch reports the failure through
         * the paths the UI already renders. A bespoke event type would be a
         * second channel for the same fact, and every reader would have to learn
         * it.
         */
        console.error(`[reaper] run fault in thread ${this.threadId} (${cause}); cancelling the turn:`, error);
        active.abortController.abort(new RunFaultError(cause, error.message));
      },
    };

    try {
      const result = await this.options.runTurn(runnerInput);
      if (active.abortController.signal.aborted) {
        /*
         * Same distinction as the catch below: an abort with a fault reason is
         * a failure, and reporting it as a plain abort would lose the cause.
         */
        const reason = active.abortController.signal.reason;
        if (reason instanceof RunFaultError) {
          return await this.finishTurn(active, {
            status: "failed",
            assistantMessage: result.assistantMessage ?? "",
            error: { name: "run_fault", message: runFaultMessage(reason) },
          });
        }
        return await this.finishTurn(active, { status: "aborted", assistantMessage: "" });
      }
      /*
       * A turn that stopped short is a failed turn, not a completed one.
       *
       * The engine has always recorded why a run stopped early in
       * `runtimeBlockers`, but the result boundary dropped the field and this
       * call site hardcoded "completed", so a run the engine knew had failed
       * closed as a success carrying an empty assistant message. In the
       * transcript that is a user message with no reply and no error — the
       * worst of the available outcomes, because there is nothing to act on.
       *
       * Which blockers count is the engine's call, not this file's — it owns
       * both the set of failure codes and the reasons they are failures. Asking
       * it means a code added there cannot be honoured in one place and ignored
       * in another, which is exactly how the empty-response fix arrived here
       * only after a second look.
       */
      const terminal = (result.runtimeBlockers ?? []).find(isStoppedShortBlocker);
      if (terminal) {
        return await this.finishTurn(active, {
          status: "failed",
          assistantMessage: result.assistantMessage ?? "",
          error: { name: terminal.code, message: terminal.message },
        });
      }
      return await this.finishTurn(active, {
        status: "completed",
        assistantMessage: result.assistantMessage ?? "",
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (active.abortController.signal.aborted || normalized.name === "AbortError") {
        /*
         * An abort carries a reason when something other than the user asked for
         * it. A run fault aborts with the error that caused it, so the cause is
         * read back off the signal: without this a fault was indistinguishable
         * from a user pressing stop, and the thread closed as "aborted" with an
         * empty message, which tells the reader nothing about what happened.
         *
         * A user interrupt still aborts with a plain error and still reads as a
         * plain abort, because that is what it is.
         */
        const reason = active.abortController.signal.reason;
        if (reason instanceof RunFaultError) {
          return await this.finishTurn(active, {
            status: "failed",
            assistantMessage: "",
            error: { name: "run_fault", message: runFaultMessage(reason) },
          });
        }
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

/**
 * An error that escaped a run and was confined to it.
 *
 * Aborted onto the turn's signal by the `onRunFault` handler, and read back by
 * `executeTurn` to close the turn as a failure carrying the cause rather than as
 * a bare "aborted". A class rather than a shape test on purpose: a user
 * interrupt aborts with a plain `Error("Turn interrupted")`, and inferring
 * "this was a fault" from the reason's shape would report a user pressing stop
 * as a runtime failure.
 */
export class RunFaultError extends Error {
  constructor(readonly cause: string, message: string) {
    super(message);
    this.name = "RunFaultError";
  }
}

/**
 * What a confined failure tells the reader.
 *
 * Two jobs: name what actually failed, and state plainly that the rest survived.
 * The second matters as much as the first, because the failure this replaces was
 * a process death where the honest report was "the server is gone and your
 * threads with it".
 */
function runFaultMessage(fault: RunFaultError): string {
  return (
    `${fault.message}\n\nSomething in this turn raised an error the runtime could not hand back to a tool, ` +
    `so the turn was stopped. The failure was confined to this thread: the server, your other threads, and the ` +
    `browser with its open pages are all intact. Send the message again, or switch models in the composer if it repeats.`
  );
}
