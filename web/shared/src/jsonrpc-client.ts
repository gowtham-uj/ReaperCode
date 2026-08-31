/**
 * Transport-agnostic JSON-RPC 2.0 client.
 *
 * The app-server sends server-*initiated* requests (approvals) that block the
 * agent's tool call until answered, so this is a peer, not just a caller: it
 * has to dispatch inbound requests as well as correlate its own responses.
 *
 * Transports are supplied by the caller — Node `ws` for the BFF and the test
 * fixture, browser `WebSocket` for the UI — so this file imports nothing
 * environment-specific.
 */

import type { JsonRpcId, JsonRpcMessage } from "./types.js";

export interface JsonRpcTransport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
export type ServerRequestHandler = (message: JsonRpcMessage) => void;
export type CloseHandler = (code: number, reason: string) => void;

interface PendingRequest {
  method: string;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private closed = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly defaultTimeoutMs = 30_000,
  ) {
    transport.onMessage((data) => this.receive(data));
    transport.onClose((code, reason) => this.handleClose(code, reason));
  }

  request(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<JsonRpcMessage> {
    if (this.closed) return Promise.reject(new Error("Connection is closed"));
    const id = this.nextId++;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (${String(id)})`));
      }, timeoutMs);
      // Node-only: keeps a pending request from holding the process open.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  /**
   * Like `request`, but rejects on a JSON-RPC error response and unwraps the
   * result. Use this when the caller only cares about the happy path.
   */
  async call<T = Record<string, unknown>>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const message = await this.request(method, params, timeoutMs);
    if (message.error) {
      throw new JsonRpcError(message.error.code, message.error.message, message.error.data);
    }
    return message.result as T;
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondWithError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      }),
    );
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(code?: number, reason?: string): void {
    this.transport.close(code, reason);
    this.handleClose(code ?? 1000, reason ?? "Client closed");
  }

  private receive(data: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return; // A malformed frame must not tear down the connection.
    }

    // Response to something we sent.
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    // Server-initiated request — an approval. Has both method and id.
    if (message.method !== undefined && message.id !== undefined) {
      for (const handler of this.serverRequestHandlers) handler(message);
      return;
    }

    // Notification.
    if (message.method !== undefined) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params ?? {});
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`Connection closed (${code})${reason ? `: ${reason}` : ""}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler(code, reason);
  }
}

/** Browser `WebSocket` adapter. Also works with Node's global WebSocket. */
export function browserTransport(socket: WebSocket): JsonRpcTransport {
  return {
    send: (data) => socket.send(data),
    onMessage: (handler) => {
      socket.addEventListener("message", (event) => handler(String((event as MessageEvent).data)));
    },
    onClose: (handler) => {
      socket.addEventListener("close", (event) => {
        const close = event as CloseEvent;
        handler(close.code, close.reason);
      });
    },
    close: (code, reason) => socket.close(code, reason),
  };
}
