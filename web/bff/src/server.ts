/**
 * The browser-facing gateway.
 *
 * Browsers cannot speak to the app-server directly: it rejects any upgrade
 * carrying an `Origin` header unless `allowBrowserOrigins` is set, and every
 * browser sends one. This process is the only thing that speaks raw
 * app-server protocol.
 *
 * The app-server currently runs without an auth token, which `assertSafeListener`
 * permits for loopback listeners. That makes reachability the entire access
 * control: anything that can open the port can drive the agent. So this server
 * binds loopback by default too, and does not widen the boundary it sits on.
 * `REAPER_APP_SERVER_TOKEN` is honored when present so enabling a token later
 * is configuration rather than a rewrite.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import type { JsonRpcClient } from "../../shared/src/jsonrpc-client.js";
import { connectToAppServer } from "./app-server-link.js";
import { Hub } from "./hub.js";
import {
  gitDiff,
  gitStatus,
  listDirectory,
  PathEscapeError,
  readWorkspaceFile,
} from "./routes.js";

/** RPCs a tab may invoke. An allowlist, so a new server method is not
 *  automatically reachable from the browser just because it shipped. */
const ALLOWED_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/name/set",
  "thread/close",
  "turn/start",
  "turn/interrupt",
  "turn/steer",
]);

export interface BffOptions {
  appServerUrl: string;
  appServerToken?: string;
  host?: string;
  port?: number;
  /** Sandbox root for the REST file/git routes. */
  workspaceRoot?: string;
}

export interface RunningBff {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startBff(options: BffOptions): Promise<RunningBff> {
  const link = await connectToAppServer({
    url: options.appServerUrl,
    ...(options.appServerToken ? { authToken: options.appServerToken } : {}),
  });
  const hub = new Hub(link.client);

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const http = createServer((request, response) => {
    void handleRest(request, response, workspaceRoot);
  });

  const wss = new WebSocketServer({ server: http, path: "/ws", perMessageDeflate: false });
  wss.on("connection", (socket: WebSocket) => {
    const tabId = hub.addTab({
      send: (payload) => socket.send(payload),
      close: () => socket.close(),
    });

    socket.on("message", (data: unknown) => {
      void handleTabMessage(hub, link.client, tabId, socket, String(data));
    });
    socket.on("close", () => hub.removeTab(tabId));
    socket.on("error", () => hub.removeTab(tabId));

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "bff/ready",
      params: { tabId, capabilities: link.capabilities },
    }));
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });

  const actualPort = (http.address() as { port: number }).port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    async close(): Promise<void> {
      link.close();
      await closeServer(wss, http);
    },
  };
}

async function handleRest(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  if (request.method !== "GET") return send(405, { error: "method_not_allowed" });

  try {
    switch (url.pathname) {
      case "/healthz":
        return send(200, { ok: true });
      case "/api/files":
        return send(200, { entries: await listDirectory(workspaceRoot, url.searchParams.get("path") ?? ".") });
      case "/api/file":
        return send(200, await readWorkspaceFile(workspaceRoot, url.searchParams.get("path") ?? ""));
      case "/api/git/status":
        return send(200, await gitStatus(workspaceRoot));
      case "/api/git/diff":
        return send(200, await gitDiff(workspaceRoot, url.searchParams.get("path") ?? undefined));
      default:
        return send(404, { error: "not_found" });
    }
  } catch (error) {
    if (error instanceof PathEscapeError) return send(403, { error: "path_outside_workspace" });
    return send(500, { error: error instanceof Error ? error.message : "internal_error" });
  }
}

async function handleTabMessage(
  hub: Hub,
  upstream: JsonRpcClient,
  tabId: string,
  socket: WebSocket,
  raw: string,
): Promise<void> {
  let message: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(raw);
  } catch {
    return; // A malformed frame must not tear down a tab's connection.
  }
  if (!message.method) return;

  const params = message.params ?? {};

  // Approval answers are not proxied as RPCs — the hub translates the tab's
  // approvalId back into the app-server's own request id.
  if (message.method === "approval/respond") {
    const outcome = hub.resolveApproval(
      tabId,
      String(params.approvalId ?? ""),
      String(params.decision ?? ""),
    );
    if (message.id !== undefined) reply(socket, message.id, outcome);
    return;
  }

  if (!ALLOWED_METHODS.has(message.method)) {
    if (message.id !== undefined) {
      replyError(socket, message.id, -32601, `Method not available: ${message.method}`);
    }
    return;
  }

  try {
    const result = await upstream.call<Record<string, unknown>>(message.method, params);

    // Register interest *before* replying, so a notification racing the reply
    // is not dropped for a thread the tab is about to render.
    const threadId = extractThreadId(message.method, params, result);
    if (threadId) hub.watchThread(tabId, threadId);
    if (message.method === "turn/start" && threadId && typeof result.turnId === "string") {
      hub.claimTurn(tabId, threadId, result.turnId);
    }

    if (message.id !== undefined) reply(socket, message.id, result);
  } catch (error) {
    if (message.id === undefined) return;
    const code = typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : -32603;
    replyError(socket, message.id, code, error instanceof Error ? error.message : "Upstream call failed");
  }
}

function extractThreadId(
  method: string,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
): string | undefined {
  if (typeof params.threadId === "string") return params.threadId;
  if (method === "thread/start") {
    const thread = result.thread as { id?: unknown } | undefined;
    if (thread && typeof thread.id === "string") return thread.id;
  }
  return undefined;
}

function reply(socket: WebSocket, id: string | number, result: unknown): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function replyError(socket: WebSocket, id: string | number, code: number, message: string): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function closeServer(wss: WebSocketServer, http: Server): Promise<void> {
  return new Promise((resolve) => {
    // `wss.close()` waits for every client socket to go away, and `http.close()`
    // waits for every keep-alive connection. Neither ends on its own, so drop
    // them explicitly first.
    for (const client of wss.clients) client.terminate();
    wss.close(() => http.close(() => resolve()));
    http.closeAllConnections();
  });
}
