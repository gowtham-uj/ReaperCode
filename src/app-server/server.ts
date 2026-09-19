import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { ProviderCredentialStore } from "../config/provider-credentials.js";
import { ProviderIntegrationRegistry } from "../model/provider/integration-registry.js";
import { PersistentMemoryStore } from "../adaptive/persistent-memory-store.js";
import { assertSafeListener, authorizeUpgrade } from "./auth.js";
import { AppServerConnection, DEFAULT_MAX_MESSAGE_BYTES } from "./connection.js";
import { AppServerMessageProcessor } from "./message-processor.js";
import { AppServerOutgoingRouter } from "./outgoing-router.js";
import type { ManagedTurnRunner } from "./managed-turn-runner.js";
import { ReaperThreadManager } from "./thread-manager.js";
import { ThreadBrowsers } from "./thread-browsers.js";
import { TransitionDb } from "../browser/transition-db.js";
import { join } from "node:path";
import { BrowserHub, VirtualAppServerConnection } from "./web/hub.js";
import { startBrowserGateway, type RunningBrowserGateway } from "./web/gateway.js";

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
  /**
   * CDP endpoint of the browser threads attach to.
   *
   * The app-server starts Steel and owns its lifecycle; this is where the
   * browser it started is listening. Overridable so a test or a differently
   * configured host points at its own.
   */
  browserCdpUrl?: string;
  /** Close a thread's browser after this long unused, in milliseconds. */
  browserIdleCloseMs?: number;
  allowBrowserOrigins?: boolean;
  heartbeatIntervalMs?: number;
  /** Test and embedding hook. CLI callers use the real RuntimeEngine runner. */
  turnRunner?: ManagedTurnRunner;
  /**
   * Where configured provider keys are read from. Defaults to the real
   * `~/.reaper/providers.json`; tests pass a store rooted at a temp home so a
   * test run can never read — or overwrite — a developer's actual keys.
   */
  credentials?: ProviderCredentialStore;
  /** Test/embedding hook for provider definitions and authentication flows. */
  providers?: ProviderIntegrationRegistry;
  /** User home for universal Settings; tests should point this at a temp home. */
  settingsHome?: string;
  /**
   * Where memory records are read from. Defaults to
   * `<workspaceRoot>/.reaper/memory` (+ `~/.reaper/memory` for user/machine
   * scope). Tests pass a store rooted at a temp dir so a run never reads a
   * developer's real memory.
   */
  memoryStore?: PersistentMemoryStore;
  /**
   * Mount the browser-facing gateway (WebSocket for tabs, REST, preview and
   * proxy) as a second listener of this same process. Loopback by
   * default. When omitted there is no browser surface — the raw protocol
   * listener is unchanged and remains the only one.
   */
  web?: { host?: string; port?: number };
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
  /** Present when the `web` option was requested and the gateway is mounted. */
  web?: RunningBrowserGateway;
  /**
   * The per-thread browser runtimes this server owns.
   *
   * Exposed because the gateway resolves a live-view request against *this*
   * registry, and a caller that wants to test or drive the live pane has to
   * reach the same one. Constructing a second `ThreadBrowsers` would attach its
   * own CDP connections and the server would not know the thread, which is
   * exactly how the pane reports "no browser" for a page that is plainly open.
   */
  threadBrowsers: ThreadBrowsers;
  stop(): Promise<void>;
}

/**
 * The app-server's brain, with no listener attached.
 *
 * Everything the processor needs, and nothing that knows how a client reaches
 * it. `startAppServer` calls this and then opens a WebSocket; a client that
 * lives in the same process calls it and drives the processor through a virtual
 * connection, the way the browser gateway already does.
 *
 * Separated because it was already being done twice in one function: the
 * browser gateway is mounted in-process (`VirtualAppServerConnection`) while
 * the raw protocol gets a socket, and both talk to this same processor. A CLI
 * client is a third caller of the same pattern, and it should not have to open
 * a port, mint a token, or fork a process to reach the agent both other
 * frontends already share.
 *
 * No listener, no port, no auth: those are properties of a *transport*, and the
 * caller owns one. That is also why this is synchronous while `startAppServer`
 * is not — the only awaiting down there is binding a socket.
 */
export function createAppServerCore(options: StartAppServerOptions): {
  processor: AppServerMessageProcessor;
  router: AppServerOutgoingRouter;
  manager: ReaperThreadManager;
  threadBrowsers: ThreadBrowsers;
} {
  const maxConcurrentTurns = options.maxConcurrentTurns ?? 2;

  /*
   * One browser owner for the server, created here beside the thread manager.
   *
   * The app-server owns the browser lifecycle: Steel is started once, and every
   * thread attaches to it through this. Creating it per turn would lose every
   * login at the end of each turn, which is the whole reason the browser is
   * attached rather than launched.
   *
   * It attaches lazily, on the first `browser_use` of a thread, so a server that
   * never browses pays nothing for it.
   */
  /*
   * The learned site graph, shared across every thread.
   *
   * Under `.reaper` beside the rest, and shared because a site's shape is not
   * per task: the second thread to visit a Greenhouse application should not
   * rediscover it. What is typed never reaches it; see `generaliseProgram`.
   */
  const flows = new TransitionDb({ path: join(options.workspaceRoot, ".reaper", "browser", "flows.json") });

  /*
   * The browser owner is created before the manager, and the reaper needs to ask
   * the manager whether a thread is mid-turn. A closure over a `let` is how the
   * later assignment is seen: the reaper only runs on its timer, long after this
   * function has returned and both have been built.
   */
  let runningTurns: ReaperThreadManager | undefined;

  const threadBrowsers = new ThreadBrowsers({
    cdpUrl: options.browserCdpUrl ?? "ws://127.0.0.1:3000",
    flows,
    ...(options.browserIdleCloseMs !== undefined ? { idleMs: options.browserIdleCloseMs } : {}),
    /*
     * A thread with a turn in flight is never reaped, however long its browser
     * has sat untouched. The activity clock catches a turn that is browsing; this
     * catches one that is thinking, which is the case the clock cannot see.
     */
    threadIsRunning: (threadId) => runningTurns?.isThreadRunning(threadId) === true,
    /*
     * Which threads still exist, so the orphan sweep can tell a real ownership
     * claim from a file a deleted thread left behind. Without this the sweep
     * does not run, which is the safe direction: a stale file used to count as a
     * claim, and the pages it named were never closed.
     */
    liveThreadIds: async () => await (runningTurns?.liveThreadIds() ?? new Set<string>()),
    /*
     * Where a thread's files live, which is where its download vault goes.
     *
     * This line is the whole feature. The runtime was given a `workspaceRoot`
     * option, the manager grew a `workspaceFor` method, and neither was connected:
     * `workspaceFor` stayed undefined, the runtime fell back to deriving the vault
     * from its state path, and every download landed outside the sandbox. A
     * mission confirmed it by failing to copy an invoice into
     * `.reaper/browser/<id>/downloads/`, the old path, while the code that would
     * have put it in the workspace sat unused one file away.
     *
     * The failure was silent because the fallback is a valid path: the vault
     * existed, downloads were "enabled", and only the model could not read the
     * file. That is why there is a wiring test now rather than a comment.
     */
    workspaceFor: (threadId) => runningTurns?.workspaceFor(threadId),
    /*
     * One state file per thread, under the same `.reaper` root everything else
     * uses. The thread id is sanitized because it reaches a filesystem path, and
     * an id is not trusted to be a safe path segment.
     */
    statePathFor: (threadId) =>
      join(options.workspaceRoot, ".reaper", "browser", `${threadId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
  });
  threadBrowsers.start();
  const router = new AppServerOutgoingRouter();
  /*
   * `processor` is read inside the manager's callbacks before it is assigned.
   * Those callbacks only fire once a turn is running, which cannot happen until
   * this function has returned and the caller has started one, so the closure
   * always sees the assigned value. Typed as possibly-undefined rather than
   * asserted so the ordering stays visible.
   */
  let processor: AppServerMessageProcessor | undefined;
  const manager = new ReaperThreadManager({
    threadBrowsers,
    dataRoot: options.workspaceRoot,
    maxConcurrentTurns,
    ...(options.maxReplayEvents !== undefined ? { maxReplayEvents: options.maxReplayEvents } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.turnRunner ? { turnRunner: options.turnRunner } : {}),
    /*
     * The same store the processor uses for Settings, so the two cannot
     * disagree about which home they are reading.
     */
    ...(options.credentials ? { credentials: options.credentials } : {}),
    /*
     * The same settings home the processor reads Settings from, so a turn's
     * disabled-provider list is the one the browser is showing.
     */
    ...(options.settingsHome ? { settingsHome: options.settingsHome } : {}),
    onApprovalRequested: async (request) => {
      await processor?.handleApprovalRequest(request);
    },
    onApprovalSettled: (request, decision) => {
      processor?.handleApprovalSettled(request, decision);
    },
  });
  runningTurns = manager;
  processor = new AppServerMessageProcessor({
    workspaceRoot: options.workspaceRoot,
    manager,
    router,
    maxConcurrentTurns,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.settingsHome ? { settingsHome: options.settingsHome } : {}),
    ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
  });

  /*
   * Clear workspace directories whose thread no longer exists, once at boot.
   *
   * The record is the source of truth for existence, so a directory under the
   * managed root with no record is garbage: it is what a delete by another
   * process, a crash midway through one, or an older build leaves behind.
   * Measured before this: thirteen empty workspace directories survived a purge
   * and nothing would ever have removed them.
   *
   * Deliberately not awaited. A boot must not fail or wait on housekeeping, and
   * the sweep is best effort by construction: it logs nothing and throws nothing.
   */
  void manager.sweepOrphanWorkspaces().catch(() => undefined);

  return { processor, router, manager, threadBrowsers };
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

  /*
   * The router is needed here as well as inside the core: the heartbeat below
   * pings every connection, and the browser gateway registers its virtual
   * connection with it. Both are transport concerns, which is exactly what the
   * core leaves to its caller.
   */
  const { processor, router, manager, threadBrowsers } = createAppServerCore(options);

  const httpServer = createHttpServer();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max((options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES) * 2, 64 * 1024),
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

  // The browser gateway shares this process but is a separate listener. It
  // presents one virtual connection to the processor, so every tab is
  // multiplexed in-process — no network hop, no second source of truth.
  let browser: RunningBrowserGateway | undefined;
  if (options.web) {
    const hub = new BrowserHub((value) => {
      // `processor` is definitely assigned: the gateway is mounted after the
      // processor is constructed above.
      void processor.process(virtualConnection, value).catch(() => undefined);
    });
    const virtualConnection = new VirtualAppServerConnection(hub);
    processor.addConnection(virtualConnection);
    router.addConnection(virtualConnection);
    // Initialize the virtual connection once on behalf of the whole browser
    // surface; individual tabs never run the handshake themselves.
    hub.capabilities = await hub.call<Record<string, unknown>>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "reaper-web-gateway", version: "0.1.0" },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
    browser = await startBrowserGateway({
      host: options.web.host ?? "127.0.0.1",
      port: options.web.port ?? 0,
      workspaceRoot: options.workspaceRoot,
      hub,
      threadBrowsers,
      /*
       * Where Steel's cast socket lives, and the endpoint the browser attaches
       * to. Both are passed so the preview proxy can refuse to forward to
       * either: they are Reaper's own services, not dev servers, and reaching
       * them through a preview would hand out control the scoping exists to
       * keep in. See `web/reserved-ports.ts`.
       */
      cdpUrl: threadBrowsers.cdpUrl,
      ...(steelApiUrlFor(threadBrowsers.cdpUrl) !== undefined
        ? { steelApiUrl: steelApiUrlFor(threadBrowsers.cdpUrl)! }
        : {}),
      // A thread's own workspace root, read from its persisted metadata. This
      // is what scopes the files/diff panes to the conversation rather than to
      // whatever directory the app-server happened to start in.
      resolveThreadRoot: async (threadId) => {
        try {
          const thread = await manager.getThread(threadId);
          return thread.metadata.workspaceRoot;
        } catch {
          return undefined;
        }
      },
    });
  }

  const heartbeat = setInterval(() => {
    for (const connection of router.listConnections()) connection.heartbeat();
  }, options.heartbeatIntervalMs ?? 30_000);
  heartbeat.unref();

  let stopped = false;
  return {
    ready,
    manager,
    threadBrowsers,
    ...(browser ? { web: browser } : {}),
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      router.closeAll();
      await manager.shutdown();
      await Promise.all([
        closeWebSocketServer(wss),
        closeHttpServer(httpServer),
        ...(browser ? [browser.close()] : []),
        /*
         * Detaches each thread's Playwright connection. It does not stop Chrome:
         * Steel owns that process, and closing it here would be a decision about
         * Steel's lifecycle made by the wrong component. What stops Steel is
         * whoever started it.
         */
        threadBrowsers.close(),
      ]);
    },
  };
}

/**
 * Steel's REST/cast base URL, from the browser's CDP endpoint.
 *
 * The endpoint the agent connects to *is* the Steel API: `websocketUrl` is
 * built from the same host and port that serve the REST routes, and the CDP
 * proxy is the upgrade fallthrough on that port (see
 * `vendor/steel-browser/api/src/plugins/browser-socket/browser-socket.ts`). So
 * this is a scheme swap, not a port swap. It used to map `:9222` to `:3000`,
 * which was correct only while the browser attached to raw Chrome; once the
 * endpoint became Steel's, that mapping looked for a port that never appears
 * and silently returned undefined, leaving the pane on a constant.
 *
 * Returns undefined only for a URL that cannot be parsed, so a caller falls
 * back to the default rather than being handed a bad host.
 */
function steelApiUrlFor(cdpUrl: string | undefined): string | undefined {
  if (cdpUrl === undefined || cdpUrl.length === 0) return undefined;
  try {
    const parsed = new URL(cdpUrl);
    const scheme = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "https" : "http";
    return `${scheme}://${parsed.host}`;
  } catch {
    return undefined;
  }
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

