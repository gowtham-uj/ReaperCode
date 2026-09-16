/**
 * Run one turn through the app-server, whoever is hosting it.
 *
 * This is the single entry point the CLI uses, and it is deliberately blind to
 * whether the server is in this process or across a socket. The caller gets
 * notifications as they arrive and a result when the turn ends; nothing above
 * this file branches on the transport, which is what stops the CLI and the web
 * UI from drifting apart the way they had.
 *
 * The shape of a turn is the protocol's, not this file's invention:
 *
 *   initialize       the server requires a handshake before anything else
 *   thread/start     creates or adopts a thread
 *   turn/start       returns *immediately* with the turn in progress
 *   ...notifications until turn/completed
 *
 * The last point is the one worth stating: `turn/start` is not a synchronous
 * call that returns the answer. It accepts the work and replies at once, and
 * the answer arrives as `item/agentMessage/delta` frames. So this waits on the
 * completion notification rather than on the `turn/start` response, which is
 * the difference between streaming and appearing to hang.
 */
import { randomUUID } from "node:crypto";

import { JsonRpcClient, JsonRpcError } from "../../web/shared/src/jsonrpc-client.js";
import type { AppTurn, AppThreadItem } from "../../web/shared/src/types.js";

export interface CliTurnRequest {
  workspaceRoot: string;
  prompt: string;
  /** Thread id to adopt, which is what `--session` becomes. Absent starts a
   *  fresh thread. */
  threadId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * Defaults to `yolo`, matching what `reaper exec run` has always done: a
   * non-interactive runner has no way to surface a prompt, so anything stricter
   * turns "needs confirmation" into a hard refusal rather than a question.
   */
  permissionMode?: "yolo" | "accept_edits" | "auto" | "strict";
  /**
   * Whether the thread's shell commands are confined to its workspace.
   *
   * Absent leaves the thread's stored setting alone, which matters for
   * `--session`: a thread configured from the web UI keeps its setting when a
   * terminal drives it, rather than having it reset by a flag nobody passed.
   */
  filesystemSandbox?: boolean;
  /** Called for every notification the server sends during the turn. */
  onNotification?(method: string, params: Record<string, unknown>): void;
  /**
   * Answers a server-initiated approval request. Absent means decline, which is
   * the only honest default for a runner that cannot ask (see `approvals.ts`).
   */
  onApproval?(request: {
    approvalId: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<"accept" | "acceptForSession" | "decline" | "cancel">;
  /** Aborts the turn by sending `turn/interrupt`. */
  signal?: AbortSignal;
}

export interface CliTurnResult {
  status: "completed" | "failed" | "interrupted";
  assistantMessage: string;
  toolResults: Array<{ id: string; name: string; result: unknown }>;
  notices: Array<{ kind: string; message: string }>;
  threadId: string;
  turnId: string;
  /** The projected turn, for `--json`. */
  turn?: AppTurn;
}

export interface CliClientHandle {
  runTurn(request: CliTurnRequest): Promise<CliTurnResult>;
  dispose(): void;
}

type NotificationParams = Record<string, unknown>;

/**
 * Everything one turn accumulates, filled by a single notification handler.
 *
 * Kept as one object rather than several closures so the collector and the
 * waiter cannot disagree about what the turn did: both read the same fields,
 * and `turn/completed` is the one event that ends the wait and seals the
 * result.
 */
interface TurnCollector {
  assistantMessage: string;
  toolResults: CliTurnResult["toolResults"];
  notices: CliTurnResult["notices"];
  turnId: string;
  turn?: AppTurn;
  done: Promise<void>;
  finish(): void;
  fail(message: string): void;
  status: CliTurnResult["status"];
  error?: { message: string };
}

function createCollector(
  client: JsonRpcClient,
  onNotification: CliTurnRequest["onNotification"],
  onApproval: CliTurnRequest["onApproval"],
): { collector: TurnCollector; setExpectedTurn(turnId: string): void; dispose(): void } {
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let settled = false;

  const collector: TurnCollector = {
    assistantMessage: "",
    toolResults: [],
    notices: [],
    turnId: "",
    status: "completed",
    done,
    finish(): void {
      if (settled) return;
      settled = true;
      settle();
    },
    fail(message: string): void {
      collector.status = "failed";
      collector.error = { message };
      collector.notices.push({ kind: "error", message });
      collector.finish();
    },
  };

  /*
   * Frames that arrive before the collector knows which turn it is waiting for.
   *
   * Attaching to an existing thread replays that thread's whole transcript as
   * live notifications, and in-process delivery is synchronous, so those frames
   * land while `collector.turnId` is still empty — and so do the first frames
   * of our own turn, which the server can emit before `turn/start` resolves.
   * Two earlier attempts got this wrong in opposite directions: adopting the
   * first turn seen made a resumed turn return the *previous* turn's answer,
   * and dropping everything while the id was unknown made it return nothing at
   * all.
   *
   * Buffering is what separates them, because the frames are distinguishable by
   * the `turnId` they carry even when we do not yet know which one we want.
   * Once the id is known the buffer is drained through the same filter the live
   * path uses, so exactly one turn's frames survive and no frame is lost.
   */
  let pending: Array<{ method: string; params: NotificationParams }> = [];

  const offNotification = client.onNotification((method: string, params: NotificationParams) => {
    onNotification?.(method, params);
    if (collector.turnId === "") {
      pending.push({ method, params });
      return;
    }
    if (pending.length > 0) {
      const buffered = pending;
      pending = [];
      for (const frame of buffered) ingest(frame.method, frame.params);
    }
    ingest(method, params);
  });

  /** Does this notification announce the turn we are waiting for? */
  function setExpectedTurn(turnId: string): void {
    collector.turnId = turnId;
    const buffered = pending;
    pending = [];
    for (const frame of buffered) ingest(frame.method, frame.params);
  }

  function ingest(method: string, params: NotificationParams): void {
    const item = params.item as (AppThreadItem & { id?: string }) | undefined;
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (method === "turn/started") return;
    if (eventTurnId !== undefined && eventTurnId !== collector.turnId) return;

    if (method === "item/agentMessage/delta") {
      if (typeof params.delta === "string") collector.assistantMessage += params.delta;
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (!item?.id || method !== "item/completed") return;
      /*
       * The completed item is authoritative, which is why results are taken
       * from here rather than accumulated from deltas: it is the version the
       * transcript shows, and a delta stream can be interrupted without the
       * row being wrong.
       */
      const completed = item as AppThreadItem & { id: string };
      if (completed.type === "agentMessage" && typeof completed.text === "string" && !collector.assistantMessage.trim()) {
        // A provider that sent the whole message with no deltas still answers.
        collector.assistantMessage = completed.text;
      }
      if (completed.type === "commandExecution" && completed.aggregatedOutput) {
        collector.toolResults.push({ id: completed.id, name: "bash", result: completed.aggregatedOutput });
      }
      if (completed.type === "dynamicToolCall") {
        collector.toolResults.push({ id: completed.id, name: completed.tool, result: completed.result });
      }
      if (completed.type === "fileChange") {
        collector.toolResults.push({ id: completed.id, name: "fileChange", result: completed.changes });
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn as (AppTurn & { error?: { message?: string } }) | undefined;
      // A different turn on the same connection must not end this wait.
      if (turn?.id && collector.turnId && turn.id !== collector.turnId) return;
      if (turn) collector.turn = turn;
      collector.status = turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "completed";
      if (turn && "error" in turn && turn.error?.message) collector.notices.push({ kind: "error", message: turn.error.message });
      collector.finish();
      return;
    }
    if (method === "error" || method === "warning") {
      const message = typeof params.message === "string" ? params.message : JSON.stringify(params);
      collector.notices.push({ kind: method, message });
    }
  }

  const offRequest = client.onServerRequest((message) => {
    if (message.id === undefined) return;
    const approvalId = typeof message.params?.approvalId === "string" ? message.params.approvalId : String(message.id);
    void (async () => {
      // Declining by default is deliberate: an unattended run that silently
      // accepted every risky call would defeat the permission mode entirely.
      const decision = onApproval
        ? await onApproval({ approvalId, method: message.method ?? "", params: (message.params ?? {}) as Record<string, unknown> })
        : "decline";
      client.respond(message.id!, { decision });
    })();
  });

  const offClose = client.onClose((code: number) => {
    collector.fail(`The connection to the app-server closed (${code}) before the turn finished`);
  });

  return {
    collector,
    setExpectedTurn,
    dispose: () => {
      offNotification();
      offRequest();
      offClose();
    },
  };
}

/**
 * Get a usable thread id, whether that means creating one or adopting one.
 *
 * A `--session` name is both: the first run has to create the thread, and every
 * run after it has to attach to the same one so the conversation continues.
 * The protocol splits those into `thread/start` and `thread/resume`, and each
 * refuses the other's case — start errors with "Thread already exists", resume
 * with "Thread was not found". The caller should not have to know which side of
 * that it is on, so this tries the likelier one and falls back.
 *
 * Resume first when a name was given, because continuing an existing session is
 * the common case for a repeated `--session`, and start first otherwise so the
 * server mints the id.
 *
 * The thread's own model pins are preserved across a resume: passing provider
 * or model again would silently retarget a thread the user had configured.
 */
async function resolveThread(client: JsonRpcClient, request: CliTurnRequest): Promise<string> {
  const startParams = {
    workspaceRoot: request.workspaceRoot,
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    // The CLI is unattended. This is the guarantee `exec run` gave by
    // construction, now stated explicitly on the wire.
    permissionMode: request.permissionMode ?? "yolo",
    subscribe: true,
    ephemeral: false,
    newWorkspace: false,
  };

  const isMissing = (error: unknown): boolean =>
    error instanceof JsonRpcError && /was not found|not_found/i.test(error.message);
  const isDuplicate = (error: unknown): boolean =>
    error instanceof JsonRpcError && /already exists|thread_exists/i.test(error.message);

  const start = async (): Promise<string> => {
    const started = await client.call<{ thread?: { id?: string } }>("thread/start", {
      ...startParams,
      ...(request.threadId ? { threadId: request.threadId } : {}),
    });
    const id = started.thread?.id;
    if (!id) throw new Error("The app-server returned a thread without its id");
    return id;
  };

  const resume = async (threadId: string): Promise<string> => {
    const resumed = await client.call<{ thread?: { id?: string } }>("thread/resume", {
      threadId,
      subscribe: true,
      // From the beginning: this run has never seen the thread, so it wants the
      // whole journal rather than the tail after some earlier sequence.
      afterSequence: 0,
    });
    const id = resumed.thread?.id ?? threadId;
    return id;
  };

  const threadId = await (async (): Promise<string> => {
    if (!request.threadId) return await start();
    try {
      return await resume(request.threadId);
    } catch (error) {
      if (isDuplicate(error)) return await resume(request.threadId);
      if (!isMissing(error)) throw error;
      // The session name has no thread behind it yet, which is what the first
      // run of a `--session` looks like.
      try {
        return await start();
      } catch (fallback) {
        if (isDuplicate(fallback)) return await resume(request.threadId);
        throw fallback;
      }
    }
  })();

  /*
   * Only when the caller actually named it. `thread/start` has no field for
   * this, so it travels as a config write after the thread exists — and
   * writing it unconditionally would mean a `--session` run silently reset a
   * setting the web UI had changed.
   */
  if (request.filesystemSandbox !== undefined) {
    await client.call("thread/config/set", {
      threadId,
      filesystemSandbox: request.filesystemSandbox,
    });
  }
  return threadId;
}

export function createCliClient(client: JsonRpcClient): CliClientHandle {
  /*
   * The handshake is once per connection, not once per turn.
   *
   * The server refuses a second `initialize` with "Connection is already
   * initialized", so a client that called it on every `runTurn` worked for the
   * first turn and failed on the second. Kept as a promise rather than a
   * boolean so two concurrent calls cannot both decide to initialize before
   * either has finished.
   */
  let handshake: Promise<unknown> | undefined;
  const ensureInitialized = (): Promise<unknown> => {
    handshake ??= client.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "reaper-cli", version: "0.1.0" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
    return handshake;
  };

  return {
    async runTurn(request: CliTurnRequest): Promise<CliTurnResult> {
      await ensureInitialized();

      /*
       * The collector is attached BEFORE the turn starts, not after. A short
       * turn can emit `turn/started` and `turn/completed` in the same tick as
       * the `turn/start` response, and a listener registered after the response
       * would miss both and hang until the timeout. This is the ordering that
       * makes a fast reply work.
       */
      const { collector, setExpectedTurn, dispose } = createCollector(client, request.onNotification, request.onApproval);

      try {
        const threadId = await resolveThread(client, request);

        const onAbort = (): void => {
          void client
            .call("turn/interrupt", { threadId, ...(collector.turnId ? { turnId: collector.turnId } : {}) })
            .catch(() => undefined);
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });

        try {
          /*
           * The turn id is minted here and passed in, rather than read from the
           * response, and that ordering is what makes the guard above work.
           *
           * `turn/start` returns the id it assigned, but the turn's
           * notifications can be delivered before that response resolves —
           * in-process delivery is synchronous. A collector that learned its
           * turn id from the response would therefore drop its own turn's first
           * frames, which is the same class of bug as the replay it exists to
           * fix, pointing the other way.
           *
           * Minting it here means `expectTurn` is already set when the turn
           * begins, so the replayed transcript is filtered and this turn's
           * frames are kept, with no dependency on delivery order.
           */
          /*
           * The turn id is minted here and passed in, rather than read from the
           * response, and that ordering is what makes the buffered frames
           * resolvable. In-process delivery is synchronous, so the server can
           * emit a turn's notifications before `turn/start` resolves; knowing the
           * id first means the buffer can be drained against it the moment the
           * call returns, with nothing depending on delivery order.
           */
          const expected = `turn-${randomUUID()}`;
          setExpectedTurn(expected);
          const started = await client.call<{ turnId?: string; turn?: { id?: string } }>("turn/start", {
            threadId,
            prompt: request.prompt,
            turnId: expected,
          });
          // The server echoes the id back; if it assigned a different one, the
          // collector has to follow it or it would filter out its own turn.
          const assigned = started.turnId ?? started.turn?.id;
          if (assigned && assigned !== expected) setExpectedTurn(assigned);

          await collector.done;

          return {
            status: collector.status,
            assistantMessage: collector.assistantMessage,
            toolResults: collector.toolResults,
            notices: collector.notices,
            threadId,
            turnId: collector.turnId,
            ...(collector.turn ? { turn: collector.turn } : {}),
          };
        } finally {
          request.signal?.removeEventListener("abort", onAbort);
        }
      } finally {
        dispose();
      }
    },
    dispose: () => client.close(),
  };
}

export { JsonRpcError };
