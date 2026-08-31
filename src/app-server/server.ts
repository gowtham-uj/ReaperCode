import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { assertSafeListener, authorizeUpgrade } from "./auth.js";
import { AppServerConnection } from "./connection.js";
import { AppServerMessageProcessor } from "./message-processor.js";
import { AppServerOutgoingRouter } from "./outgoing-router.js";
import type { ManagedTurnRunner } from "./managed-turn-runner.js";
import { ReaperThreadManager } from "./thread-manager.js";

export interface StartAppServerOptions {
  workspaceRoot: string;
  listen?: string;
  authToken?: string;
  maxConcurrentTurns?: number;
  maxMessageBytes?: number;
  maxInboundMessages?: number;
  maxOutboundMessages?: number;
  maxOutboundBytes?: number;
  outboundFlushDelayMs?: number;
  maxReplayEvents?: number;
  approvalTimeoutMs?: number;
  allowBrowserOrigins?: boolean;
  heartbeatIntervalMs?: number;
  /** Test and embedding hook. CLI callers use the real RuntimeEngine runner. */
  turnRunner?: ManagedTurnRunner;
}

export interface AppServerReadyRecord {
  type: "reaper.app-server.ready";
  protocolVersion: 1;
  url: string;
  healthUrl: string;
  pid: number;
}

export interface RunningAppServer {
  ready: AppServerReadyRecord;
  manager: ReaperThreadManager;
  stop(): Promise<void>;
}

export async function startAppServer(options: StartAppServerOptions): Promise<RunningAppServer> {
  const listenUrl = new URL(options.listen ?? "ws://127.0.0.1:0");
  if (listenUrl.protocol !== "ws:") throw new Error("App server currently supports ws:// listeners only");
  if (listenUrl.username || listenUrl.password || listenUrl.search || listenUrl.hash) {
    throw new Error("The app-server listen URL cannot include credentials, query parameters, or a fragment");
  }
  const host = listenUrl.hostname;
  const port = parsePort(listenUrl.port);
  const websocketPath = normalizePath(listenUrl.pathname);
  assertSafeListener({
    host,
    ...(options.authToken ? { authToken: options.authToken } : {}),
    ...(options.allowBrowserOrigins !== undefined ? { allowBrowserOrigins: options.allowBrowserOrigins } : {}),
  });

  const maxConcurrentTurns = options.maxConcurrentTurns ?? 2;
  const router = new AppServerOutgoingRouter();
  let processor: AppServerMessageProcessor | undefined;
  const manager = new ReaperThreadManager({
    dataRoot: options.workspaceRoot,
    maxConcurrentTurns,
    ...(options.maxReplayEvents !== undefined ? { maxReplayEvents: options.maxReplayEvents } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.turnRunner ? { turnRunner: options.turnRunner } : {}),
    onApprovalRequested: async (request) => {
      await processor?.handleApprovalRequest(request);
    },
    onApprovalSettled: (request, decision) => {
      processor?.handleApprovalSettled(request, decision);
    },
  });
  processor = new AppServerMessageProcessor({
    workspaceRoot: options.workspaceRoot,
    manager,
    router,
    maxConcurrentTurns,
  });

  const httpServer = createHttpServer();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max((options.maxMessageBytes ?? 1024 * 1024) * 2, 64 * 1024),
    perMessageDeflate: false,
  });
  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (normalizePath(requestUrl.pathname) !== websocketPath) {
      rejectUpgrade(socket, 404, "WebSocket endpoint not found");
      return;
    }
    const auth = authorizeUpgrade(request, {
      host,
      ...(options.authToken ? { authToken: options.authToken } : {}),
      ...(options.allowBrowserOrigins !== undefined ? { allowBrowserOrigins: options.allowBrowserOrigins } : {}),
    });
    if (!auth.ok) {
      rejectUpgrade(socket, auth.status, auth.message);
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  });

  wss.on("connection", (socket, request) => {
    const connection = new AppServerConnection(socket, request, {
      ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
      ...(options.maxInboundMessages !== undefined ? { maxInboundMessages: options.maxInboundMessages } : {}),
      ...(options.maxOutboundMessages !== undefined ? { maxOutboundMessages: options.maxOutboundMessages } : {}),
      ...(options.maxOutboundBytes !== undefined ? { maxOutboundBytes: options.maxOutboundBytes } : {}),
      ...(options.outboundFlushDelayMs !== undefined ? { outboundFlushDelayMs: options.outboundFlushDelayMs } : {}),
      onMessage: async (activeConnection, value) => {
        await processor?.process(activeConnection, value);
      },
      onClose: async (activeConnection) => {
        processor?.removeConnection(activeConnection);
      },
    });
    processor?.addConnection(connection);
  });

  await listen(httpServer, port, host);
  const address = httpServer.address() as AddressInfo;
  const actualHost = formatUrlHost(address.address);
  const ready: AppServerReadyRecord = {
    type: "reaper.app-server.ready",
    protocolVersion: 1,
    url: `ws://${actualHost}:${address.port}${websocketPath}`,
    healthUrl: `http://${actualHost}:${address.port}/healthz`,
    pid: process.pid,
  };

  const heartbeat = setInterval(() => {
    for (const connection of router.listConnections()) connection.heartbeat();
  }, options.heartbeatIntervalMs ?? 30_000);
  heartbeat.unref();

  let stopped = false;
  return {
    ready,
    manager,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      router.closeAll();
      await manager.shutdown();
      await Promise.all([
        closeWebSocketServer(wss),
        closeHttpServer(httpServer),
      ]);
    },
  };
}

function createHttpServer(): HttpServer {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`${JSON.stringify({ ok: true })}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ error: "not_found" })}\n`);
  });
}

function parsePort(raw: string): number {
  if (!raw) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid app-server listen port");
  return port;
}

function normalizePath(value: string): string {
  if (!value || value === "/") return "/";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found"}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "\r\n"
      + body,
  );
  socket.destroy();
}

