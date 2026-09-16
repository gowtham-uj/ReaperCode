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

import { isLoopbackHost } from "../auth.js";
import type { ThreadBrowsers } from "../thread-browsers.js";
import type { BrowserHub } from "./hub.js";
import { attachLiveView, handleBrowserControl, serveLiveViewPage } from "./live-view.js";
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

/**
 * Methods that act on a thread the caller must already be attached to.
 *
 * The gateway registered interest in any thread a tab named, which is right for
 * reading and *wrong* for changing one. Verified: a tab that had never created
 * thread X sent one `thread/workspace/set` and X's `cwd` became `/root`, after
 * which the root itself served that directory to every tab. Re-pointing a
 * thread's workspace is the strongest example, but the same hole let any page
 * rename another conversation, change its model, start a turn on it, or close
 * it.
 *
 * `thread/start` and `thread/resume` are deliberately absent: they are how a
 * tab *becomes* attached, and requiring prior attachment would make them
 * impossible to call. Everything else here assumes the thread exists, so the
 * caller has to have reached it first.
 *
 * "Attached" means the tab resumed, started, or read the thread before this
 * call. The UI does that when a conversation is opened, so a legitimate client
 * passes without changing anything about how it works.
 */
const OWNERSHIP_REQUIRED_METHODS = new Set([
  "thread/workspace/set",
  "thread/name/set",
  "thread/model/set",
  "thread/effort/set",
  "thread/config/set",
  "thread/close",
  "turn/start",
  "turn/interrupt",
  "turn/steer",
]);

/**
 * Whether a request's Origin may use this surface.
 *
 * One rule, used by both listeners. The WebSocket had it and the REST surface
 * did not, which made the guard look complete while `/api/*` stayed open to any
 * page: verified by POSTing to `/api/upload` from `Origin: http://evil.example.com`
 * and watching the bytes land on disk. A write from a page the server did not
 * serve is the case worth refusing, and refusing it on one socket while
 * accepting it on the other is not a boundary.
 *
 * The rule is same-origin against the request's own Host, which is what a
 * browser guarantees for a page this server actually served:
 *
 *   - no Origin at all is a non-browser client, already inside the loopback
 *     boundary this surface trusts;
 *   - a loopback origin is allowed, because the dev setup proxies from Vite on
 *     one loopback port to the gateway on another and those do not share a Host;
 *   - an Origin whose host matches the Host the request arrived on is the UI
 *     talking to itself, whatever hostname that is, loopback or public;
 *   - `REAPER_ALLOWED_ORIGINS` covers a deployment behind a proxy that rewrites
 *     Host;
 *   - anything else is a page this server did not serve.
 */
export function originAllowed(origin: string | undefined, requestHost: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    const parsed = new URL(origin);
    if (isLoopbackHost(parsed.hostname)) return true;
    if (typeof requestHost === "string" && requestHost.length > 0 && parsed.host === requestHost) return true;
    const allowed = (process.env["REAPER_ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return allowed.includes(origin);
  } catch {
    // A malformed Origin is not one of ours.
    return false;
  }
}

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
  /**
   * The per-thread browser runtimes, for the live-view pane.
   *
   * The pane needs the thread's own page target so it streams that page and not
   * another thread's. The target is resolved from this, never from the request,
   * which is what keeps the pane scoped to the requesting thread.
   */
  threadBrowsers: ThreadBrowsers;
  /** Base URL of the Steel API that serves the cast socket. Loopback by default. */
  steelApiUrl?: string | undefined;
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
    /*
     * The Origin check comes first, before any route is considered.
     *
     * The WebSocket had this and the REST surface did not, so a page on a
     * foreign origin could not open the socket and *could* POST to
     * `/api/upload`: verified, from `Origin: http://evil.example.com`, and the
     * bytes landed on disk. Same rule, checked once, before anything reads a
     * path or a body.
     *
     * A refused request gets no CORS headers, so a browser blocks the response
     * and a script cannot read it. The write is refused as well, which is the
     * part that matters: the body is never parsed and the file is never opened.
     */
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }
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
    /*
     * The browser handoff protocol. A POST that changes who may drive, so it is
     * routed before `handleRest` (GET-only) and it is not a file route: the
     * thread id names a conversation, not a directory, and the runtime is looked
     * up by that id rather than by a path.
     */
    if (parsed.pathname === "/api/browser-control") {
      void handleBrowserControl(request, response, { threadBrowsers: options.threadBrowsers });
      return;
    }
    /*
     * Steel's own viewer page, proxied so it shares this origin and talks to
     * our scoped cast bridge rather than Steel's session-wide socket. It is
     * HTML, so it is served before `handleRest` rather than as JSON.
     */
    if (parsed.pathname === "/api/live-view") {
      void serveLiveViewPage(request, response, {
        threadBrowsers: options.threadBrowsers,
        ...(options.steelApiUrl !== undefined ? { steelApiUrl: options.steelApiUrl } : {}),
      });
      return;
    }
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

  /*
   * `noServer`, with one dispatcher below, rather than `server` plus a path.
   *
   * `ws` aborts the handshake with a 400 when a request's path does not match
   * its configured `path`, and it destroys the socket doing so. That is fine
   * with one socket, and fatal with two: the live-view pane is a second
   * websocket on the same listener (`/api/live`), and the RPC server would kill
   * its handshake before the live-view handler ever saw it. Owning the upgrade
   * event lets each path be routed to its own server, and an unknown path be
   * refused by us with a code we chose.
   */
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    /*
     * The socket is for the UI, and only for the UI.
     *
     * This listener accepts browser origins on purpose, because it *is* the
     * browser surface, and the raw protocol's blanket refusal would break the
     * UI. But "accepts browser origins" was implemented as "accepts any origin",
     * and WebSockets are not subject to CORS: the browser sends the handshake
     * regardless and only the server can refuse it. So any page a user visited
     * could open this socket and speak the full RPC protocol.
     *
     * Verified end to end before the first guard: from a socket with
     * `Origin: http://evil.example.com`, `thread/start` accepted
     * `cwd: ~/.reaper`, and a follow-up `GET /api/file?path=settings.json` read
     * that file from the attacker-chosen root. The same request against a
     * `providers.json` would have returned the provider keys.
     *
     * That first guard accepted only loopback origins, which was right about the
     * attack and wrong about legitimate use: a published deployment serves the
     * UI from a public host, so the browser's Origin is that host, the guard
     * refused it, and every socket reset. Reproduced — `http://127.0.0.1:5273`
     * accepted, `https://167.86.121.124:5273` refused — and it looked exactly
     * like a frontend that could not reach its backend.
     *
     * So the rule is same-origin against the request's own Host, which is what a
     * browser guarantees for a page this server actually served:
     *
     *   - an Origin whose host matches the Host the request arrived on is the
     *     UI talking to itself, whatever hostname that is, loopback or public
     *   - a loopback origin is allowed as well, because the dev setup proxies
     *     from the Vite server on one loopback port to this gateway on another,
     *     and those two do not share a Host
     *   - anything else is a page this server did not serve, which is the case
     *     worth refusing
     *
     * A request with no Origin at all is a non-browser client, already inside the
     * loopback boundary this surface trusts.
     */
    verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
      originAllowed(info.origin ?? info.req.headers.origin, info.req.headers.host),
  });
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

  /*
   * The live browser pane's socket.
   *
   * Separate server, separate path, same origin guard: it is the same UI making
   * the same kind of request, so it gets the same rule rather than a second,
   * weaker one. The guard itself is reused by asking this server for its
   * `options.verifyClient`, which is the same function object the RPC server
   * validates with.
   */
  const liveWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const liveView = attachLiveView(liveWss, {
    threadBrowsers: options.threadBrowsers,
    ...(options.steelApiUrl !== undefined ? { steelApiUrl: options.steelApiUrl } : {}),
  });

  const rpcUpgrade = wss.options.verifyClient;
  http.on("upgrade", (request, socket, head) => {
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    /*
     * The live socket also accepts the thread id as a path segment, because
     * Steel's viewer appends its own query to whatever base it is given and a
     * base that already carried `?threadId=` produced a malformed URL. So the
     * prefix is part of the route, not a fixed path.
     */
    const isLivePath = pathname === "/api/live" || pathname.startsWith("/api/live/");
    if (pathname !== "/ws" && !isLivePath) {
      socket.destroy();
      return;
    }
    /*
     * The same Origin check the RPC socket uses, applied before either route.
     * A live socket is read *and* write access to a browser, so it must not be
     * reachable from an origin the RPC socket would refuse.
     */
    if (typeof rpcUpgrade === "function") {
      const originHeader = request.headers.origin;
      const allowed = (rpcUpgrade as (info: { origin?: string; req: IncomingMessage }) => boolean)({
        ...(originHeader === undefined ? {} : { origin: originHeader }),
        req: request,
      });
      if (!allowed) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (liveView.handleUpgrade(request, socket, head)) return;
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
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
      await closeServer(wss, liveWss, http);
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
  /*
   * A mutating call has to come from a tab that was already attached.
   *
   * Checked before `watchThread` below, because that call is what would
   * otherwise turn "this tab named your thread" into permission to change it.
   * The two orders are the whole difference between a boundary and a formality.
   */
  if (
    OWNERSHIP_REQUIRED_METHODS.has(message.method)
    && earlyThreadId !== undefined
    && !wasWatching
  ) {
    if (message.id !== undefined) {
      replyError(socket, message.id, -32600, "Not attached to this thread");
    }
    return;
  }
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

function closeServer(rpc: WebSocketServer, live: WebSocketServer, http: Server): Promise<void> {
  return new Promise((resolve) => {
    // `wss.close()` waits for every client socket to go away, and `http.close()`
    // waits for every keep-alive connection. Neither ends on its own, so drop
    // them explicitly first. Both websocket servers are dropped, because a live
    // view holds a socket that would otherwise keep the listener open.
    for (const client of rpc.clients) client.terminate();
    for (const client of live.clients) client.terminate();
    rpc.close(() => undefined);
    live.close(() => http.close(() => resolve()));
    http.closeAllConnections();
  });
}
