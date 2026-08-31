import { randomUUID } from "node:crypto";
import path from "node:path";
import { ZodError } from "zod";

import type { JsonRpcRequest, JsonRpcResponse } from "../connection/json-rpc.js";
import { redactSecrets } from "../logging/redaction.js";
import type { ToolApprovalDecision } from "../tools/approval.js";
import type { AppServerConnection } from "./connection.js";
import type { ThreadEventRecord } from "./event-bus.js";
import type { ManagedApprovalRequest } from "./managed-thread.js";
import { ManagedThreadError } from "./managed-thread.js";
import { AppServerOutgoingRouter } from "./outgoing-router.js";
import {
  APP_SERVER_PROTOCOL_VERSION,
  ApprovalResponseResultSchema,
  InitializeParamsSchema,
  ThreadIdParamsSchema,
  ThreadItemsListParamsSchema,
  ThreadListParamsSchema,
  ThreadNameSetParamsSchema,
  ThreadReadParamsSchema,
  ThreadResumeParamsSchema,
  ThreadStartParamsSchema,
  ThreadTurnsListParamsSchema,
  ThreadUnsubscribeParamsSchema,
  TurnInterruptParamsSchema,
  TurnStartParamsSchema,
  TurnSteerParamsSchema,
  appServerCapabilities,
  extractTextInput,
  parseAppServerMessage,
} from "./protocol.js";
import { projectHistory, projectThread, SessionProjection, type ProjectedNotification } from "./session-projection.js";
import { ReaperThreadManager, ThreadManagerError } from "./thread-manager.js";

interface ConnectionState {
  initialized: boolean;
  optOutNotificationMethods: Set<string>;
}

export interface AppServerMessageProcessorOptions {
  workspaceRoot: string;
  manager: ReaperThreadManager;
  router: AppServerOutgoingRouter;
  maxConcurrentTurns: number;
}

export class AppServerMessageProcessor {
  private readonly states = new Map<string, ConnectionState>();
  private readonly turnOwners = new Map<string, string>();
  private readonly projections = new Map<string, SessionProjection>();
  private readonly projectionCache = new Map<string, Map<number, ProjectedNotification[]>>();

  constructor(private readonly options: AppServerMessageProcessorOptions) {}

  addConnection(connection: AppServerConnection): void {
    this.states.set(connection.id, { initialized: false, optOutNotificationMethods: new Set() });
    this.options.router.addConnection(connection);
  }

  removeConnection(connection: AppServerConnection): void {
    this.states.delete(connection.id);
    this.options.router.removeConnection(connection.id);
    for (const [key, owner] of this.turnOwners) {
      if (owner === connection.id) this.turnOwners.delete(key);
    }
  }

  async process(connection: AppServerConnection, raw: unknown): Promise<void> {
    let message;
    try {
      message = parseAppServerMessage(raw);
    } catch (error) {
      this.options.router.sendError(
        connection.id,
        extractId(raw) ?? "invalid-request",
        -32600,
        "Invalid JSON-RPC message",
        error instanceof ZodError ? { issues: error.issues } : undefined,
      );
      return;
    }

    if (!("method" in message)) {
      if (!this.options.router.resolveResponse(connection.id, message)) {
        this.options.router.sendError(connection.id, message.id, -32600, "Unknown or expired server request ID");
      }
      return;
    }
    if (!("id" in message)) {
      return;
    }

    const state = this.states.get(connection.id);
    if (!state) return;
    if (!state.initialized && message.method !== "initialize") {
      this.options.router.sendError(connection.id, message.id, -32002, "initialize must be the first request");
      return;
    }

    try {
      const result = await this.dispatch(connection, state, message);
      this.options.router.sendResult(connection.id, message.id, result);
      if (message.method === "initialize") {
        this.options.router.sendNotification(connection.id, "initialized", {});
      }
    } catch (error) {
      const mapped = mapError(error);
      this.options.router.sendError(connection.id, message.id, mapped.code, mapped.message, mapped.data);
    }
  }

  async handleApprovalRequest(request: ManagedApprovalRequest): Promise<void> {
    const owner = this.turnOwners.get(turnKey(request.threadId, request.turnId));
    if (!owner) {
      await this.options.manager.resolveApproval(request.threadId, request.approvalId, "cancelled").catch(() => undefined);
      return;
    }
    try {
      const pending = await this.options.router.request(
        owner,
        approvalMethod(request),
        redactSecrets(approvalParams(request)),
      );
      const parsed = pending.response.error
        ? "cancelled"
        : ApprovalResponseResultSchema.parse(pending.response.result).decision;
      const decision: ToolApprovalDecision = parsed === "accept" || parsed === "acceptForSession" || parsed === "approved"
        ? "approved"
        : parsed === "decline" || parsed === "denied"
          ? "denied"
          : "cancelled";
      this.sendNotification(owner, "serverRequest/resolved", {
        requestId: pending.requestId,
        threadId: request.threadId,
        turnId: request.turnId,
        decision: parsed,
      });
      await this.options.manager.resolveApproval(request.threadId, request.approvalId, decision);
    } catch {
      await this.options.manager.resolveApproval(request.threadId, request.approvalId, "cancelled").catch(() => undefined);
    }
  }

  private async dispatch(
    connection: AppServerConnection,
    state: ConnectionState,
    request: JsonRpcRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "initialize": {
        if (state.initialized) throw rpcFailure(-32600, "Connection is already initialized");
        const params = InitializeParamsSchema.parse(request.params ?? {});
        state.initialized = true;
        state.optOutNotificationMethods = new Set(params.capabilities.optOutNotificationMethods);
        return {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          serverInfo: { name: "reaper-app-server" },
          capabilities: {
            ...appServerCapabilities,
            maxConcurrentTurns: this.options.maxConcurrentTurns,
          },
          clientInfo: params.clientInfo,
        };
      }
      case "thread/start": {
        const params = ThreadStartParamsSchema.parse(request.params ?? {});
        const provider = params.modelProvider ?? params.provider;
        const thread = await this.options.manager.startThread({
          ...(params.threadId ? { threadId: params.threadId } : {}),
          workspaceRoot: path.resolve(params.cwd ?? params.workspaceRoot ?? this.options.workspaceRoot),
          ...(provider ? { provider } : {}),
          ...(params.model ? { model: params.model } : {}),
          permissionMode: params.approvalPolicy ?? params.permissionMode,
          ...(params.title ? { title: params.title } : {}),
        });
        let replay;
        if (params.subscribe) replay = await this.subscribeConnection(connection, thread.threadId, 0);
        return {
          thread: projectThread(thread.metadata, []),
          model: thread.metadata.model ?? null,
          modelProvider: thread.metadata.provider ?? null,
          cwd: thread.metadata.workspaceRoot,
          approvalPolicy: thread.metadata.permissionMode,
          ...(replay ? { replay } : {}),
        };
      }
      case "thread/resume": {
        const params = ThreadResumeParamsSchema.parse(request.params);
        const thread = await this.options.manager.resumeThread(params.threadId);
        let replay;
        if (params.subscribe) {
          replay = await this.subscribeConnection(connection, params.threadId, params.afterSequence);
        }
        const turns = await this.snapshotTurns(params.threadId);
        return {
          thread: projectThread(thread.metadata, turns),
          model: thread.metadata.model ?? null,
          modelProvider: thread.metadata.provider ?? null,
          cwd: thread.metadata.workspaceRoot,
          approvalPolicy: thread.metadata.permissionMode,
          initialTurnsPage: turns,
          ...(replay ? { replay } : {}),
        };
      }
      case "thread/list": {
        const params = ThreadListParamsSchema.parse(request.params ?? {});
        let entries = await this.options.manager.listThreads();
        if (params.searchTerm) {
          entries = entries.filter((entry) => (entry.title ?? "").includes(params.searchTerm!));
        }
        if (params.sortDirection === "asc") entries.reverse();
        const page = paginate(entries, params.cursor, params.limit);
        const data = page.data.map((metadata) => projectThread(metadata));
        return { data, threads: data, nextCursor: page.nextCursor };
      }
      case "thread/read": {
        const params = ThreadReadParamsSchema.parse(request.params);
        const read = await this.options.manager.readThread(params.threadId);
        const turns = params.includeTurns ? await this.snapshotTurns(params.threadId) : undefined;
        return { thread: projectThread(read.metadata, turns) };
      }
      case "thread/turns/list": {
        const params = ThreadTurnsListParamsSchema.parse(request.params);
        let turns = await this.snapshotTurns(params.threadId);
        if (params.sortDirection === "desc") turns = [...turns].reverse();
        if (params.itemsView === "notLoaded") turns = turns.map((turn) => ({ ...turn, items: [] }));
        const page = paginate(turns, params.cursor, params.limit);
        return { data: page.data, nextCursor: page.nextCursor, backwardsCursor: null };
      }
      case "thread/items/list": {
        const params = ThreadItemsListParamsSchema.parse(request.params);
        let turns = await this.snapshotTurns(params.threadId);
        let entries = turns
          .filter((turn) => !params.turnId || turn.id === params.turnId)
          .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })));
        if (params.sortDirection === "desc") entries = [...entries].reverse();
        const page = paginate(entries, params.cursor, params.limit);
        return { data: page.data, nextCursor: page.nextCursor, backwardsCursor: null };
      }
      case "thread/name/set": {
        const params = ThreadNameSetParamsSchema.parse(request.params);
        const metadata = await this.options.manager.setThreadName(params.threadId, params.name);
        this.sendNotification(connection.id, "thread/name/updated", {
          threadId: params.threadId,
          threadName: metadata.title,
        });
        return {};
      }
      case "thread/unsubscribe": {
        const params = ThreadUnsubscribeParamsSchema.parse(request.params);
        connection.subscriptions.get(params.threadId)?.();
        connection.subscriptions.delete(params.threadId);
        return { unsubscribed: true };
      }
      case "thread/close": {
        const params = ThreadIdParamsSchema.parse(request.params);
        await this.options.manager.closeThread(params.threadId);
        return { closed: true };
      }
      case "thread/loaded/list": {
        ThreadListParamsSchema.parse(request.params ?? {});
        const loaded = (await this.options.manager.listThreads())
          .filter((metadata) => this.options.manager.peekThread(metadata.threadId))
          .map((metadata) => metadata.threadId);
        return { data: loaded, threadIds: loaded };
      }
      case "turn/start": {
        const params = TurnStartParamsSchema.parse(request.params);
        const prompt = extractTextInput(params);
        const turnId = params.turnId ?? `turn-${randomUUID()}`;
        const key = turnKey(params.threadId, turnId);
        this.turnOwners.set(key, connection.id);
        try {
          const handle = await this.options.manager.startTurn(params.threadId, {
            prompt,
            turnId,
          });
          void handle.completion.finally(() => {
            if (this.turnOwners.get(key) === connection.id) this.turnOwners.delete(key);
          });
          return {
            threadId: params.threadId,
            turnId: handle.turnId,
            accepted: true,
            turn: { id: handle.turnId, status: "inProgress", items: [] },
          };
        } catch (error) {
          this.turnOwners.delete(key);
          throw error;
        }
      }
      case "turn/interrupt": {
        const params = TurnInterruptParamsSchema.parse(request.params);
        const interrupted = await this.options.manager.interruptTurn(params.threadId, params.turnId);
        return { interrupted };
      }
      case "turn/steer": {
        const params = TurnSteerParamsSchema.parse(request.params);
        const turnId = params.expectedTurnId ?? params.turnId;
        if (!turnId) throw rpcFailure(-32602, "turn/steer requires turnId or expectedTurnId");
        return await this.options.manager.steerTurn(params.threadId, turnId, extractTextInput(params));
      }
      default:
        throw rpcFailure(-32601, `Method not found: ${request.method}`);
    }
  }

  private async snapshotTurns(threadId: string) {
    let projection = this.projections.get(threadId);
    if (!projection) {
      projection = new SessionProjection();
      this.projections.set(threadId, projection);
    }
    const read = await this.options.manager.readThread(threadId);
    projection.hydrate(projectHistory(read.messages));
    return projection.snapshotTurns();
  }

  private async subscribeConnection(
    connection: AppServerConnection,
    threadId: string,
    afterSequence: number,
  ): Promise<{ earliestSequence: number; latestSequence: number; truncated: boolean }> {
    await this.snapshotTurns(threadId).catch(() => undefined);
    connection.subscriptions.get(threadId)?.();
    const buffered: ThreadEventRecord[] = [];
    let replaying = true;
    const subscription = await this.options.manager.subscribe(
      threadId,
      connection.id,
      (event) => {
        if (replaying) buffered.push(event);
        else this.sendThreadEvent(connection.id, event);
      },
      afterSequence,
    );
    connection.subscriptions.set(threadId, subscription.unsubscribe);
    for (const event of subscription.replay.events) this.sendThreadEvent(connection.id, event);
    replaying = false;
    for (const event of buffered) {
      if (event.sequence > subscription.replay.latestSequence) this.sendThreadEvent(connection.id, event);
    }
    if (subscription.replay.truncated) {
      this.options.router.sendNotification(connection.id, "warning", {
        threadId,
        code: "replay_truncated",
        message: "The requested replay offset is older than the in-memory replay window. Use thread/read for persisted conversation history.",
        earliestSequence: subscription.replay.earliestSequence,
      });
    }
    return {
      earliestSequence: subscription.replay.earliestSequence,
      latestSequence: subscription.replay.latestSequence,
      truncated: subscription.replay.truncated,
    };
  }

  private sendThreadEvent(connectionId: string, record: ThreadEventRecord): void {
    let threadCache = this.projectionCache.get(record.threadId);
    if (!threadCache) {
      threadCache = new Map();
      this.projectionCache.set(record.threadId, threadCache);
    }
    let notifications = threadCache.get(record.sequence);
    if (!notifications) {
      let projection = this.projections.get(record.threadId);
      if (!projection) {
        projection = new SessionProjection();
        this.projections.set(record.threadId, projection);
      }
      notifications = projection.project(record, this.options.manager.peekThread(record.threadId)?.metadata);
      threadCache.set(record.sequence, notifications);
      while (threadCache.size > 2_000) {
        const oldest = threadCache.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        threadCache.delete(oldest);
      }
    }
    for (const notification of notifications) {
      this.sendNotification(connectionId, notification.method, notification.params);
    }
  }

  private sendNotification(connectionId: string, method: string, params: unknown): boolean {
    if (this.states.get(connectionId)?.optOutNotificationMethods.has(method)) return true;
    return this.options.router.sendNotification(connectionId, method, params);
  }
}

function approvalParams(request: ManagedApprovalRequest): Record<string, unknown> {
  const common = {
    threadId: request.threadId,
    turnId: request.turnId,
    approvalId: request.approvalId,
    itemId: request.toolCall.id,
    reason: request.reason,
    ...(request.ruleMatch ? { ruleMatch: request.ruleMatch } : {}),
  };
  if (request.toolCall.name === "bash") {
    return {
      ...common,
      command: "cmd" in (request.toolCall.args as object) && typeof (request.toolCall.args as { cmd?: unknown }).cmd === "string"
        ? (request.toolCall.args as { cmd: string }).cmd
        : "",
      cwd: request.workingDirectory,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
  }
  if (["write_file", "edit_file", "file_edit", "apply_patch", "delete_file"].includes(request.toolCall.name)) {
    return {
      ...common,
      grantRoot: request.workspaceRoot,
      changes: request.toolCall.args,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
  }
  return {
    ...common,
    tool: request.toolCall.name,
    arguments: request.toolCall.args as Record<string, unknown>,
    availableDecisions: ["accept", "decline", "cancel"],
  };
}

function approvalMethod(request: ManagedApprovalRequest): string {
  if (request.toolCall.name === "bash") return "item/commandExecution/requestApproval";
  if (["write_file", "edit_file", "file_edit", "apply_patch"].includes(request.toolCall.name)) {
    return "item/fileChange/requestApproval";
  }
  if (request.toolCall.name === "request_human_approval") return "item/tool/requestUserInput";
  return "item/tool/requestApproval";
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId} ${turnId}`;
}

function extractId(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function rpcFailure(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

function paginate<T>(data: T[], cursor: string | undefined, limit: number): { data: T[]; nextCursor: string | null } {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw rpcFailure(-32602, "Invalid pagination cursor");
  const page = data.slice(offset, offset + limit);
  const next = offset + page.length;
  return { data: page, nextCursor: next < data.length ? String(next) : null };
}

function mapError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof ZodError) return { code: -32602, message: "Invalid method parameters", data: { issues: error.issues } };
  if (error instanceof ThreadManagerError) {
    return { code: error.code === "thread_not_found" ? -32004 : -32003, message: error.message, data: { reason: error.code } };
  }
  if (error instanceof ManagedThreadError) {
    return { code: error.code === "turn_in_progress" ? -32010 : -32011, message: error.message, data: { reason: error.code } };
  }
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "number") {
    return {
      code: (error as Error & { code: number }).code,
      message: error.message,
      ...("data" in error ? { data: (error as Error & { data?: unknown }).data } : {}),
    };
  }
  return { code: -32603, message: error instanceof Error ? error.message : "Internal server error" };
}
