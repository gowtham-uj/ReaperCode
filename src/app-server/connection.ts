import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";

/**
 * The minimal surface the message processor and outgoing router need from a
 * "connection".
 *
 * A real client is an `AppServerConnection` over a socket. The browser gateway
 * is not — it is many tabs multiplexed in-process — so it presents one
 * *virtual* connection (implementing this interface) that the processor treats
 * as the single reviewer, while the gateway fans out envelopes to the right tab
 * behind it. Extracting the interface is what makes that possible without the
 * processor ever knowing whether it is talking to a socket or a multiplexer.
 */
export interface AppServerClientConnection {
  readonly id: string;
  /**
   * Per-thread unsubscribe callbacks, keyed by thread id. The processor stores
   * each live subscription here so `thread/unsubscribe` and connection teardown
   * can release them. A virtual multiplexing connection (the browser gateway)
   * shares one map across all of its tabs, which is exactly the old BFF's
   * behavior over its single upstream connection.
   */
  readonly subscriptions: Map<string, () => void>;
  sendJson(value: unknown): boolean;
  close(code?: number, reason?: string): void;
  heartbeat(): void;
}

/**
 * The largest JSON-RPC message a client may send, unless the server is
 * constructed with `maxMessageBytes`.
 *
 * Exported because it is a contract, not an implementation detail: the
 * bounded provider RPCs (`provider/list`, `provider/models/list`) exist
 * precisely to stay under it, and their tests assert against this value
 * rather than a magic number that could drift away from the enforcement
 * point below.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface AppServerConnectionOptions {
  maxMessageBytes?: number;
  maxInboundMessages?: number;
  maxOutboundMessages?: number;
  maxOutboundBytes?: number;
  /** Test hook: delay each successful socket write so a bounded writer queue can fill. */
  outboundFlushDelayMs?: number;
  onMessage: (connection: AppServerConnection, value: unknown) => void | Promise<void>;
  onClose?: (connection: AppServerConnection) => void | Promise<void>;
}

interface OutboundEntry {
  text: string;
  bytes: number;
}

export class AppServerConnection implements AppServerClientConnection {
  readonly id = randomUUID();
  readonly subscriptions = new Map<string, () => void>();
  private readonly inbound: unknown[] = [];
  private readonly outbound: OutboundEntry[] = [];
  private inboundRunning = false;
  private outboundRunning = false;
  private outboundBytes = 0;
  private closed = false;
  private alive = true;

  constructor(
    readonly socket: WebSocket,
    readonly request: IncomingMessage,
    private readonly options: AppServerConnectionOptions,
  ) {
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("pong", () => { this.alive = true; });
    socket.on("close", () => { void this.handleClose(); });
    socket.on("error", () => { this.close(1011, "WebSocket error"); });
  }

  sendJson(value: unknown): boolean {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(text);
    const maxMessages = this.options.maxOutboundMessages ?? 512;
    const maxBytes = this.options.maxOutboundBytes ?? 8 * 1024 * 1024;
    if (this.outbound.length >= maxMessages || this.outboundBytes + bytes > maxBytes) {
      this.close(1013, "Client is not consuming messages fast enough");
      return false;
    }
    this.outbound.push({ text, bytes });
    this.outboundBytes += bytes;
    void this.flushOutbound();
    return true;
  }

  heartbeat(): void {
    if (this.closed) return;
    if (!this.alive) {
      this.close(1001, "Heartbeat timeout");
      return;
    }
    this.alive = false;
    try {
      this.socket.ping();
    } catch {
      this.close(1001, "Heartbeat failed");
    }
  }

  close(code = 1000, reason = "Closing"): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason.slice(0, 123));
    } catch {
      this.socket.terminate();
    }
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      this.sendJson(rpcError("binary-message", -32600, "Binary WebSocket messages are not supported"));
      return;
    }
    const bytes = rawDataLength(data);
    if (bytes > (this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)) {
      this.sendJson(rpcError("oversized-message", -32600, "WebSocket message exceeds the configured limit", {
        retryable: false,
      }));
      this.close(1009, "Message too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataText(data));
    } catch {
      this.sendJson(rpcError("parse-error", -32700, "Invalid JSON"));
      return;
    }
    if (this.inbound.length >= (this.options.maxInboundMessages ?? 128)) {
      this.sendJson(rpcError(extractId(parsed) ?? "inbound-overload", -32001, "Inbound request queue is full", {
        retryable: true,
      }));
      return;
    }
    this.inbound.push(parsed);
    void this.drainInbound();
  }

  private async drainInbound(): Promise<void> {
    if (this.inboundRunning) return;
    this.inboundRunning = true;
    try {
      while (!this.closed) {
        const value = this.inbound.shift();
        if (value === undefined) break;
        try {
          await this.options.onMessage(this, value);
        } catch {
          this.sendJson(rpcError(extractId(value) ?? "internal-error", -32603, "Internal server error"));
        }
      }
    } finally {
      this.inboundRunning = false;
      if (this.inbound.length > 0 && !this.closed) void this.drainInbound();
    }
  }

  private async flushOutbound(): Promise<void> {
    if (this.outboundRunning) return;
    this.outboundRunning = true;
    try {
      while (!this.closed && this.socket.readyState === WebSocket.OPEN) {
        const entry = this.outbound.shift();
        if (!entry) break;
        this.outboundBytes -= entry.bytes;
        await new Promise<void>((resolve, reject) => {
          this.socket.send(entry.text, (error) => error ? reject(error) : resolve());
        });
        const delayMs = this.options.outboundFlushDelayMs ?? 0;
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            timer.unref();
          });
        }
      }
    } catch {
      this.close(1011, "WebSocket send failed");
    } finally {
      this.outboundRunning = false;
      if (this.outbound.length > 0 && !this.closed) void this.flushOutbound();
    }
  }

  private async handleClose(): Promise<void> {
    if (!this.closed) this.closed = true;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.inbound.length = 0;
    this.outbound.length = 0;
    this.outboundBytes = 0;
    await this.options.onClose?.(this);
  }
}

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, item) => sum + item.byteLength, 0);
  return data.byteLength;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

function extractId(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function rpcError(id: string | number, code: number, message: string, data?: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
