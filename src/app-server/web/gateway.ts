/**
 * The browser-facing gateway, mounted inside the app-server process.
 *
 * This is the former BFF, now one listening surface of the same server: it
 * serves the browser WebSocket (`/ws`), the path-sandboxed REST routes, the
 * preview proxy, and the browser-screenshot route. It shares
 * the app-server's `BrowserHub`, so tabs are multiplexed over one virtual
 * connection with no network hop in between.
 *
 * It is a separate listener from the raw app-server protocol on purpose. The
 * raw protocol keeps its strict upgrade policy (no browser `Origin`, unless
 * `allowBrowserOrigins` — which must stay off); this listener accepts browser
 * origins because it *is* the browser surface. Keeping the two on separate
 * ports means publishing this one (`reaper-port publish <port>`) never widens
 * the raw protocol's reachability, and an app-server bound non-loopback with a
 * token does not accidentally expose the browser surface beside it.
 *
 * Security: the preview proxy hardcodes its loopback target,
 * REST is sandboxed to the workspace root, and screenshots are png-only and
 * capped. Nothing here widens the loopback boundary on its own.
 */

import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import type { BrowserHub } from "./hub.js";
import { parsePreviewPath, proxyPreview } from "./preview.js";
import {
  gitDiff,
  gitStatus,
  listDirectory,
  MAX_UPLOAD_BYTES,
  PathEscapeError,
  readBrowserScreenshot,
  readWorkspaceFile,
  UploadTooLargeError,
  writeWorkspaceUpload,
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
  "thread/workspace/set",
  "thread/model/set",
  "thread/effort/set",
  "thread/config/set",
  "thread/close",
  "turn/start",
  "turn/interrupt",
  "turn/steer",
  // Settings surface. `provider/credentials/set` is the only inbound path that
  // carries a secret; nothing on the way back ever does — the app-server
  // answers with a masked summary, so the gateway has no key to accidentally log.
  "model/catalog",
  "provider/list",
  "provider/models/list",
  "provider/catalog/status",
  "provider/catalog/refresh",
  "provider/auth/methods",
  "provider/auth/api/set",
  // Returns a verdict about a stored credential, never the credential itself.
  "provider/auth/check",
  "provider/auth/oauth/start",
  "provider/auth/oauth/complete",
  "provider/auth/oauth/status",
  "provider/remove",
  // Compatibility aliases for non-upgraded clients.
  "provider/credentials/list",
  "provider/credentials/set",
  "provider/credentials/remove",
  // Settings and policy (Phase 6). All read-only except the two writes —
  // `settings/write` returns an allowlisted summary (never secrets) and
  // `policy/rules/write` writes rules.local.md through a regex-validated,
  // root-sandboxed path. Permission changes are user-wide through settings/write.
  // Read-only tool inventory: names and descriptions, no schemas, no secrets.
  "tools/list",
  "workspace/skills/list",
  "workspace/extensions/list",
  "settings/read",
  "settings/write",
  "policy/rules/read",
  "policy/rules/write",
]);

export interface BrowserGatewayOptions {
  host: string;
  port: number;
  /**
   * Fallback sandbox root for a REST request that names no thread.
   *
   * This is the *server's* workspace, which for a dev run is the ReaperCode
   * checkout itself. It is only ever used when a request omits `threadId`;
   * every thread-scoped request resolves its own root instead (see
   * `rootForRequest`).
   */
  workspaceRoot: string;
  hub: BrowserHub;
  /**
   * The workspace root recorded on a thread's metadata, or undefined if no
   * such thread exists.
   *
   * The REST routes are per-thread because a thread *is* a workspace: its
   * files, its git history, and its `.reaper/sessions/app-<threadId>/` journal all
   * live under one directory. Serving every thread from one server-wide root
   * showed the agent's own source tree in the files pane no matter which
   * conversation was open.
   */
  resolveThreadRoot(threadId: string): Promise<string | undefined>;
}

export interface RunningBrowserGateway {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startBrowserGateway(options: BrowserGatewayOptions): Promise<RunningBrowserGateway> {
  const { hub, workspaceRoot, resolveThreadRoot } = options;

  /**
   * The sandbox root for one REST request.
   *
   * An unknown thread id resolves to `undefined` rather than silently falling
   * back to the server root: answering a request for thread X with thread Y's
   * — or the agent's own — files is worse than answering not-found, because it
   * looks like it worked.
   */
  const rootForRequest = async (url: URL): Promise<string | undefined> => {
    const threadId = url.searchParams.get("threadId");
    if (!threadId) return workspaceRoot;
    return await resolveThreadRoot(threadId);
  };

  const http = createServer((request, response) => {
    // The streaming routes first: they are not JSON, they stream a body, and
    // they must pass through arbitrary methods. Routing them through
    // `handleRest` would mean its GET-only guard rejected a preview form
    // submission.
    const url = request.url ?? "/";
    const preview = parsePreviewPath(url);
    if (preview) return proxyPreview(preview, request, response);
    // A browser screenshot is binary; the JSON `handleRest` cannot serve it.
    // It is routed before the JSON surface and must be a GET like the rest.
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/screenshot") {
      const screenshotPath = parsed.searchParams.get("path");
      if (screenshotPath) {
        void rootForRequest(parsed).then((root) => {
          if (!root) return sendJson(response, 404, { error: "unknown_thread" });
          return handleScreenshot(request, response, root, screenshotPath);
        });
        return;
      }
    }
    // The one write. It is routed before `handleRest` because that handler
    // rejects everything but GET, and it is the only route on this surface
    // that is allowed to be something other than a read.
    void rootForRequest(parsed).then((root) =>
      parsed.pathname === "/api/upload"
        ? handleUpload(request, response, root)
        : handleRest(request, response, root));
  });

  const wss = new WebSocketServer({ server: http, path: "/ws", perMessageDeflate: false });
  wss.on("connection", (socket: WebSocket) => {
    const tabId = hub.addTab({
      send: (payload) => socket.send(payload),
      close: () => socket.close(),
    });

    socket.on("message", (data: unknown) => {
      void handleTabMessage(hub, tabId, socket, String(data));
    });
    socket.on("close", () => hub.removeTab(tabId));
    socket.on("error", () => hub.removeTab(tabId));

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "browser/ready",
      params: { tabId, capabilities: hub.capabilities },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      http.off("error", reject);
      resolve();
    });
  });

  const actualPort = (http.address() as { port: number }).port;
  return {
    url: `http://${options.host}:${actualPort}`,
    port: actualPort,
    async close(): Promise<void> {
      await closeServer(wss, http);
    },
  };
}

/**
 * Serve one browser screenshot. Binary, so it sits outside the JSON handler;
 * the sandbox and the png-only constraint live in `readBrowserScreenshot`.
 */
async function handleScreenshot(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string,
  requestedPath: string,
): Promise<void> {
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  try {
    const shot = await readBrowserScreenshot(workspaceRoot, requestedPath);
    response.writeHead(200, {
      "content-type": shot.contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(shot.bytes);
  } catch (error) {
    const status = error instanceof PathEscapeError ? 403 : 404;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: status === 403 ? "path_outside_workspace" : "not_found" }));
  }
}

/**
 * Accept one file into the open thread's folder.
 *
 * The body is the file itself, with the destination directory and filename in
 * the query string, rather than a multipart form — there is exactly one file,
 * no other fields, and parsing a multipart body would mean either a dependency
 * or a hand-rolled parser sitting in front of the only write on this surface.
 *
 * The read is cap-first: the declared `content-length` is checked before a byte
 * is taken off the socket, and the running total is checked as chunks arrive,
 * so an oversized upload is refused without ever being buffered whole. A
 * chunked request declares no length, which is why both checks exist.
 */
async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string | undefined,
): Promise<void> {
  const send = (status: number, body: unknown): void => sendJson(response, status, body);
  if (request.method !== "POST") return send(405, { error: "method_not_allowed" });
  if (!workspaceRoot) return send(404, { error: "unknown_thread" });

  const url = new URL(request.url ?? "/", "http://localhost");
  // Relative to the thread's folder. A folder upload sends every file in the
  // picked directory as its own request, each carrying its path below the
  // folder, which is what recreates the tree.
  const relativePath = url.searchParams.get("path") ?? "";

  const declared = Number(request.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return send(413, { error: "upload_too_large", maxBytes: MAX_UPLOAD_BYTES });
  }

  let body: Buffer;
  try {
    body = await readBody(request, MAX_UPLOAD_BYTES);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return send(413, { error: "upload_too_large", maxBytes: MAX_UPLOAD_BYTES });
    }
    return send(400, { error: "bad_request" });
  }

  try {
    const written = await writeWorkspaceUpload(workspaceRoot, { path: relativePath, bytes: body });
    return send(200, written);
  } catch (error) {
    if (error instanceof PathEscapeError) return send(403, { error: "path_outside_workspace" });
    // The upload replaced a directory, or the folder is read-only. Both are
    // about the request, not about this server, so they are 400s with the
    // detail kept in the log.
    console.error("[gateway] /api/upload failed:", error);
    return send(400, { error: "upload_failed" });
  }
}

/**
 * Read a request body up to `limit` bytes, refusing the rest.
 *
 * `request.destroy()` on overflow is what makes the cap real: without it the
 * sender keeps pushing a body nobody is reading and the socket sits in
 * backpressure until the client gives up.
 */
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        request.destroy();
        reject(new UploadTooLargeError(total));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function handleRest(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown): void => sendJson(response, status, body);

  if (request.method !== "GET") return send(405, { error: "method_not_allowed" });

  // `/healthz` answers before the thread check: it reports whether the gateway
  // is up, which is true regardless of whether some thread id resolved.
  if (url.pathname === "/healthz") return send(200, { ok: true });
  if (!workspaceRoot) return send(404, { error: "unknown_thread" });

  try {
    switch (url.pathname) {
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
    // ENOENT is an ordinary state, not a server fault — but *which* thing is
    // missing changes what the user should do, so the root is checked rather
    // than reporting a deleted workspace for every absent file.
    if ((error as { code?: string }).code === "ENOENT") {
      const rootExists = await stat(workspaceRoot).then(() => true).catch(() => false);
      return send(404, { error: rootExists ? "not_found" : "workspace_missing" });
    }
    // Node's filesystem errors carry the absolute server path in `message`.
    // That is the app-server's layout, which a browser has no business
    // learning, so the detail stays in the log and the client gets a code.
    console.error(`[gateway] ${url.pathname} failed:`, error);
    return send(500, { error: "internal_error" });
  }
}

async function handleTabMessage(
  hub: BrowserHub,
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

  // Register interest *before* the call, not after it resolves.
  //
  // `thread/resume` with `subscribe: true` makes the processor flush the
  // entire replay backlog — and the `replay_truncated` warning — while the call
  // is still in flight. Registering afterwards means every one of those
  // notifications arrives for a thread this tab is not yet watching, and
  // `routeNotification` drops them. The symptom is the worst kind: reconnect
  // reports success, and the missed transcript never appears.
  //
  // Only possible when the thread id is in the params. `thread/start` mints its
  // id server-side, but a brand-new thread has nothing to replay, so the
  // post-hoc registration below is sufficient for it.
  const earlyThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const wasWatching = earlyThreadId ? hub.isWatching(tabId, earlyThreadId) : false;
  if (earlyThreadId) hub.watchThread(tabId, earlyThreadId);

  try {
    const result = await hub.call<Record<string, unknown>>(message.method, params);

    const threadId = extractThreadId(message.method, params, result);
    if (threadId) hub.watchThread(tabId, threadId);
    if (message.method === "turn/start" && threadId && typeof result.turnId === "string") {
      hub.claimTurn(tabId, threadId, result.turnId);
    }

    if (message.id !== undefined) reply(socket, message.id, result);
  } catch (error) {
    // The call failed, so the tab is not on this thread after all. Roll the
    // speculative registration back — unless it was already watching, in which
    // case a failed `turn/start` must not silently unsubscribe it.
    if (earlyThreadId && !wasWatching) hub.unwatchThread(tabId, earlyThreadId);
    if (message.id === undefined) return;
    const code = typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : -32603;
    replyError(socket, message.id, code, error instanceof Error ? error.message : "Call failed");
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
