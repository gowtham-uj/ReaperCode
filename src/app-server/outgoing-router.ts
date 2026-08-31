import { randomUUID } from "node:crypto";

import type { JsonRpcResponse } from "../connection/json-rpc.js";
import type { AppServerConnection } from "./connection.js";
import type { JsonRpcId } from "./protocol.js";

interface PendingServerRequest {
  connectionId: string;
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AppServerOutgoingRouter {
  private readonly connections = new Map<string, AppServerConnection>();
  private readonly pending = new Map<JsonRpcId, PendingServerRequest>();

  addConnection(connection: AppServerConnection): void {
    this.connections.set(connection.id, connection);
  }

  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId);
    for (const [id, pending] of this.pending) {
      if (pending.connectionId !== connectionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error("Approval reviewer disconnected"));
    }
  }

  sendResult(connectionId: string, id: JsonRpcId, result: unknown): boolean {
    return this.send(connectionId, { jsonrpc: "2.0", id, result });
  }

  sendError(connectionId: string, id: JsonRpcId, code: number, message: string, data?: unknown): boolean {
    return this.send(connectionId, {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  sendNotification(connectionId: string, method: string, params: unknown): boolean {
    return this.send(connectionId, { jsonrpc: "2.0", method, params });
  }

  /**
   * `onSent` fires with the generated request id once the request is on the
   * wire, so callers can correlate it before the response arrives — needed to
   * notify the reviewer if the request is settled from elsewhere.
   */
  request(
    connectionId: string,
    method: string,
    params: unknown,
    timeoutMs = 120_000,
    onSent?: (requestId: JsonRpcId) => void,
  ): Promise<{ requestId: JsonRpcId; response: JsonRpcResponse }> {
    const connection = this.connections.get(connectionId);
    if (!connection) return Promise.reject(new Error("Approval reviewer is not connected"));
    const id = `server-${randomUUID()}`;
    return new Promise<{ requestId: JsonRpcId; response: JsonRpcResponse }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Server request timed out"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        connectionId,
        resolve: (response) => resolve({ requestId: id, response }),
        reject,
        timer,
      });
      if (!connection.sendJson({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Could not send server request"));
        return;
      }
      onSent?.(id);
    });
  }

  resolveResponse(connectionId: string, response: JsonRpcResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending || pending.connectionId !== connectionId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
    return true;
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close(1001, "Server shutting down");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Server shutting down"));
    }
    this.pending.clear();
    this.connections.clear();
  }

  getConnection(connectionId: string): AppServerConnection | undefined {
    return this.connections.get(connectionId);
  }

  listConnections(): AppServerConnection[] {
    return [...this.connections.values()];
  }

  private send(connectionId: string, value: unknown): boolean {
    return this.connections.get(connectionId)?.sendJson(value) ?? false;
  }
}
