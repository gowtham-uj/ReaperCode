/**
 * The live browser pane: the thread's own page, streamed to the UI.
 *
 * Steel already streams a session: `ws://<steel>/v1/sessions/cast?pageId=<id>`
 * sends screencast frames and accepts mouse, key and navigation events back, so
 * a viewer can watch and drive the same Chromium the agent is driving. Its own
 * viewer page (`/v1/sessions/debug?interactive=true`) is a client of that
 * socket.
 *
 * What Steel does not do is scope it. Its cast endpoint follows a *session*,
 * and every Reaper thread shares one session: one `connectOverCDP` sees one
 * browser with every thread's context in it. So Steel's tab list would offer
 * every thread's pages, and pointing the pane at Steel directly would show one
 * agent another agent's tabs. That is the same leak the `scoped-page.ts`
 * boundary exists to close, one layer down.
 *
 * So this module is the scoping layer, and it is the only thing the UI talks
 * to:
 *
 *   - the caller names a *thread*, never a page id. The page id is resolved
 *     here, from that thread's own runtime, so there is no id a client can
 *     supply that names somebody else's tab.
 *   - the page must be the thread's pinned active target. The id is read from
 *     the runtime that owns the page, not from the request and not from Steel's
 *     session-wide tab list.
 *   - a thread with no browser yet is refused with a reason, rather than
 *     falling back to the session's first page, which is another thread's.
 *
 * The bridge is deliberately a byte pump in both directions. Frames are
 * forwarded as they arrive and events are forwarded as they are sent, because
 * the pane is meant to be live: re-encoding either side would add a layer that
 * can disagree with Steel about the protocol, which is versioned and not ours.
 */

import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { renderHandoffEvent } from "../../browser/control-lease.js";
import type { ThreadBrowsers } from "../thread-browsers.js";

/**
 * Where Steel's cast endpoint lives, derived from the CDP URL.
 *
 * The CDP URL points at the browser's debugging port (`:9222`); the REST API
 * that serves the cast socket is the Steel server itself, on `:3000` by
 * default. Steel's own session object reports `websocketUrl`, and this mirrors
 * that rather than re-deriving it, because a deployment that moves Steel to a
 * different host would otherwise silently point the pane at nothing.
 */
export interface LiveViewOptions {
  threadBrowsers: ThreadBrowsers;
  /**
   * The base URL of the Steel API, e.g. `http://127.0.0.1:3000`.
   *
   * Loopback by default, and never taken from the request. A cast socket is an
   * access-bearing capability: anyone who can open it can watch and drive the
   * browser. It is proxied through the gateway, which carries the session
   * auth, precisely so that capability is never handed to a client directly.
   */
  steelApiUrl?: string;
  /** Milliseconds to wait for Steel to accept the upstream socket. */
  connectTimeoutMs?: number;
}

export interface LiveViewSession {
  /** The thread's page target id, which is what makes the stream scoped. */
  targetId: string;
  close(): void;
}

/**
 * Why a live view could not be started, in terms the UI can show.
 *
 * A typed reason rather than a thrown string because the UI distinguishes
 * "the agent has not opened a page yet, try again shortly" from "this server
 * cannot reach the browser", and only the first is worth a retry button.
 */
export type LiveViewFailure = "no-browser" | "no-page" | "upstream-unreachable" | "upstream-refused";

/**
 * How the streaming code above refers to a thread whose page could be resolved.
 *
 * Kept as a type so the two callers (the socket bridge and the viewer page)
 * cannot drift apart on which failure means "try again shortly" and which means
 * "this server cannot reach the browser".
 */
export type ResolvedPage = { targetId: string } | { failure: LiveViewFailure; detail: string };

const DEFAULT_STEEL_API_URL = "http://127.0.0.1:3000";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The page id to stream for one thread, or a reason there is none.
 *
 * This is the whole scoping guarantee in one function: the id comes from the
 * runtime that owns the thread's pages, so a client that names a thread can
 * only ever get that thread's active page.
 */
export async function resolveThreadPageTarget(
  threadBrowsers: ThreadBrowsers,
  threadId: string,
): Promise<{ targetId: string } | { failure: LiveViewFailure; detail: string }> {
  /*
   * The browser is attached on demand rather than waited for.
   *
   * The pane used to refuse when a thread had no runtime, on the theory that a
   * thread which has not run `browser_use` has nothing to show. That is the
   * wrong model of what a page is: a thread's browser is *its own context*, and
   * the page the agent will act on already exists the moment the context does,
   * as a blank tab. Waiting for the first tool call meant the pane was empty
   * through the part of a task where the user most wants to see it, and then
   * appeared suddenly, which reads as the pane being broken until it isn't.
   *
   * Attaching here creates this thread's context and its page, and that page is
   * the one every later `browser_use` call drives: the tool calls `ensureReady`
   * and resolves the same active page. So the pane shows the agent's real page
   * from the start, including while it is still blank.
   *
   * The cost is one CDP connection for a thread whose pane is opened, which the
   * idle reaper closes again when the thread goes quiet. That is the same
   * connection the first tool call would have opened anyway.
   *
   * The scoping guarantee is unchanged: `forThread` and the runtime it returns
   * are keyed by this thread id, and the target id is read from *that* runtime,
   * so a request still cannot name another thread's page.
   */
  const runtime = threadBrowsers.forThread(threadId);
  try {
    /*
     * `ensureReady` attaches if needed. It is deliberately called rather than
     * assuming a live connection, because the pane is often opened *before* the
     * agent's first action and the honest answer there is to wait for the page
     * rather than to fail the pane.
     */
    const { page } = await runtime.ensureReady();
    const targetId = runtime.activeTargetId ?? (await runtime.pinActiveTarget(page));
    if (!targetId) {
      return { failure: "no-page", detail: "the thread's page has no browser target id yet" };
    }
    return { targetId };
  } catch (error) {
    return {
      failure: "no-page",
      detail: `could not resolve this thread's page: ${(error as Error).message}`,
    };
  }
}

/**
 * Open Steel's cast socket for one page id.
 *
 * The pageId is passed through untouched: Steel matches it against its own
 * target ids, and the id came from this thread's runtime, so it is the thread's
 * page and not another's.
 */
export function openSteelCast(
  steelApiUrl: string,
  targetId: string,
  timeoutMs: number,
): Promise<WebSocket> {
  const base = steelApiUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  const url = `${base}/v1/sessions/cast?pageId=${encodeURIComponent(targetId)}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for the browser stream"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Serve Steel's own viewer page, rewired to talk to this gateway.
 *
 * Steel ships a complete viewer at `/v1/sessions/debug`: it draws the browser
 * chrome (address bar, tab strip, back/forward/reload), renders screencast
 * frames to a canvas, and sends mouse and key events back. Writing that UI
 * again here would be a worse copy of it.
 *
 * What it cannot do is be pointed at cross-origin, and what it must not do is
 * connect to Steel's own socket, which is session-wide: that socket's tab list
 * is every thread's pages. So the page is proxied and one line is rewritten,
 * its `baseWsUrl`, to point at `/api/live` on this gateway. Everything else,
 * including the frame format and the input events, is unchanged, because the
 * bridge is a passthrough of the same protocol Steel's viewer already speaks.
 *
 * The `pageId` is this thread's page, resolved here. So the viewer is put into
 * single-page mode: it asks for one page and never sends a tab-list request,
 * which is the mechanism that would otherwise enumerate other threads' tabs.
 */
export async function serveLiveViewPage(
  request: IncomingMessage,
  response: ServerResponse,
  options: { threadBrowsers: ThreadBrowsers; steelApiUrl?: string | undefined },
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/live-view") return false;

  const send = (status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  const threadId = url.searchParams.get("threadId");
  if (!threadId) {
    send(400, { error: "missing_thread" });
    return true;
  }

  const resolved = await resolveThreadPageTarget(options.threadBrowsers, threadId);
  if ("failure" in resolved) {
    /*
     * A page rather than JSON, because this URL is loaded as an iframe's src
     * and the browser would render a JSON blob as text. The message is rendered
     * into the same dark surface the viewer uses so a waiting pane looks like a
     * waiting pane rather than a broken one.
     */
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reaper browser</title>` +
      `<style>html,body{margin:0;height:100%;background:#171717;color:#c9c9c9;` +
      `font:13px/1.5 ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;` +
      `justify-content:center;text-align:center;padding:24px}</style></head>` +
      `<body><p>${escapeHtml(resolved.detail)}</p></body></html>`,
    );
    return true;
  }

  /*
   * Multi-tab mode, deliberately, so the viewer draws a tab strip.
   *
   * Steel's viewer decides between one page and a tab strip with one test: does
   * the URL carry a `pageId`. Given one it hides the strip and connects
   * straight to that page; given none it asks its socket for the tab list and
   * renders it, connecting per tab as the user switches.
   *
   * The pane wants the strip, because a thread's browser is not one page: the
   * agent opens tabs, closes them, and switches between them, and a viewer
   * pinned to whichever page was active when the pane loaded would go silent the
   * moment the agent moved on. So no `pageId` is passed, and the tab list comes
   * from this thread's own pages through the bridge above.
   *
   * The page the thread is currently on still matters, and it is still resolved
   * by the check above: that is what turns "the agent has no browser" into a
   * sentence instead of a spinner. It is just not what the viewer is pinned to.
   */
  const steelApiUrl = options.steelApiUrl ?? process.env["REAPER_STEEL_API_URL"] ?? DEFAULT_STEEL_API_URL;
  const upstream = new URL(`${steelApiUrl.replace(/\/+$/, "")}/v1/sessions/debug`);
  upstream.searchParams.set("interactive", "true");

  let html: string;
  try {
    const fetched = await fetch(upstream, { signal: AbortSignal.timeout(5_000) });
    if (!fetched.ok) throw new Error(`the viewer returned HTTP ${fetched.status}`);
    html = await fetched.text();
  } catch (error) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#171717;color:#c9c9c9;` +
      `font:13px ui-sans-serif,system-ui,sans-serif;padding:24px">could not load the browser view: ` +
      `${escapeHtml((error as Error).message)}</body></html>`,
    );
    return true;
  }

  /*
   * One line, rewritten. The template builds every socket URL from `baseWsUrl`
   * (single-page mode returns it untouched, multi-page appends a page or a tab
   * query), so repointing it moves the whole viewer onto this gateway without
   * touching its protocol.
   *
   * The replacement is derived from `location` in the page rather than baked in
   * as an absolute URL, so the viewer works whether it was reached over
   * loopback, through the published hostname, or over TLS: a hardcoded `ws://`
   * would be blocked as mixed content the moment the pane is served over https.
   */
  const rewired = html.replace(
    /const baseWsUrl = '[^']*';/,
    /*
     * The thread id is a path segment so that Steel's own `?tabInfo=true` and
     * `?pageId=<id>` appends are the only query on the URL. With a query of our
     * own, the first append produced `?threadId=...?tabInfo=true` and the viewer
     * hung on "Session connecting" with nothing to explain it. See the note in
     * `handleUpgrade`.
     */
    `const baseWsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/api/live/${encodeURIComponent(threadId)}';`,
  );

  /*
   * A second rewrite, of layout rather than wiring.
   *
   * Steel's viewer sizes its canvas to the *height* of the pane and lets the
   * width follow (`height: 100%; width: auto`), centred, in a container that
   * clips (`overflow: hidden`). That is right for a viewer on a wide screen and
   * wrong for a side pane: the pane is tall and narrow, so a height-fitted
   * canvas is wider than the pane, the sides are cut off, and the page is
   * unreadable at exactly the size the pane is.
   *
   * So the canvas is fitted to the *width* instead, and the container scrolls
   * vertically. The aspect ratio is preserved by the canvas' own intrinsic
   * size (its width and height attributes are the frame's pixel dimensions), so
   * `height: auto` keeps the page undistorted while the pane decides how much
   * of it is on screen at once.
   *
   * The input mapping is unaffected: the viewer computes every mouse coordinate
   * from `canvas.getBoundingClientRect()` against the frame's own dimensions
   * (`scaleX`/`scaleY`), so a canvas drawn at any size still sends the right
   * page coordinates. Verified by reading that handler rather than assuming it.
   */
  const layoutOverride = [
    "<style>",
    /* The scroll container. `block` rather than the flex centring it ships with,
       because a flex item cannot grow taller than its container to scroll. */
    "#content{display:block!important;overflow-y:auto!important;overflow-x:hidden!important;align-items:initial!important;justify-content:initial!important}",
    /* The frame wrapper, back in normal flow so it can be taller than the pane. */
    "#content .canvas-container{position:relative!important;width:100%!important;height:auto!important}",
    "#content .canvas-container.active{display:block!important}",
    /* The canvas itself, fitted to the width and free to be as tall as it needs. */
    "#content .canvas{position:relative!important;left:auto!important;transform:none!important;display:block!important;width:100%!important;height:auto!important;max-width:none!important;max-height:none!important;object-fit:contain!important}",
    /* A dark gutter, so a page shorter than the pane does not end in white. */
    "#content{background:#171717!important}",
    "</style>",
  ].join("");

  const rewritten = rewired.includes("</head>")
    ? rewired.replace("</head>", `${layoutOverride}</head>`)
    : `${rewired}${layoutOverride}`;

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(rewritten);
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
  ));
}

/**
 * Handle `POST /api/browser-control`, the take-control / return-control
 * protocol.
 *
 * An explicit protocol rather than an inferred one. The tempting alternative is
 * to guess from the viewer's activity when the human is done, and it does not
 * work: a human who is reading a page looks identical to one who has walked
 * away, and a human mid-login looks identical to one who has finished. Asking
 * the browser to infer the end of a task it cannot see is the mistake this
 * endpoint exists to avoid, so the human says so.
 *
 * Returns true when the request was handled, false when the path is not ours,
 * so the caller can fall through to its other routes.
 */
export async function handleBrowserControl(
  request: IncomingMessage,
  response: ServerResponse,
  options: { threadBrowsers: ThreadBrowsers },
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/browser-control") return false;

  const send = (status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  const threadId = url.searchParams.get("threadId");
  if (!threadId) {
    send(400, { error: "missing_thread" });
    return true;
  }

  /*
   * GET reads the lease. The pane calls it on mount so a tab opened while the
   * human already holds control shows that, rather than resetting the button to
   * "Take control" and inviting a second takeover of a session already owned.
   */
  if (request.method === "GET") {
    /*
     * Read from the registry, not from a runtime, so this answers for any
     * thread. A thread the agent has not touched yet is agent-owned at
     * generation 0, which is the honest answer and needs no browser to give:
     * going through a runtime would mean attaching a browser to answer a
     * question about who owns one that does not exist.
     */
    const lease = options.threadBrowsers.control.lease(threadId);
    send(200, { owner: lease.owner, generation: lease.generation, since: lease.since });
    return true;
  }

  if (request.method !== "POST") {
    send(405, { error: "method_not_allowed" });
    return true;
  }

  const action = url.searchParams.get("action");
  if (action !== "take" && action !== "return") {
    send(400, { error: "bad_action", detail: "action must be 'take' or 'return'" });
    return true;
  }

  /*
   * A handoff needs the runtime, because both directions do work the lease
   * alone cannot: taking control records where the page was so the return can
   * report what changed, and returning reads the page fresh. So the browser is
   * attached here if it was not already, which matches the pane: by the time a
   * user can press either button they are looking at a page.
   */
  const runtime = options.threadBrowsers.forThread(threadId);

  try {
    if (action === "take") {
      const result = await runtime.beginHumanControl();
      send(200, { owner: "human", generation: result.generation, since: result.startedAt });
      return true;
    }
    const result = await runtime.endHumanControl();
    /*
     * The resync payload the UI shows and the model reads. The perception is
     * fetched here, after the observer was reset and re-captured, so what the
     * model gets is the page as it is now rather than a delta against the
     * pre-handoff view.
     */
    const view = await runtime.view();
    send(200, {
      owner: "agent",
      generation: result.generation,
      summary: result.summary,
      event: renderHandoffEvent(result.summary, view.text),
    });
    return true;
  } catch (error) {
    send(500, { error: "control_failed", detail: (error as Error).message });
    return true;
  }
}

/**
 * Mount the live-view upgrade handler on a websocket server.
 *
 * Path is `/api/live`. It is a separate path from `/ws` (the RPC socket)
 * because the two speak different protocols and have different lifetimes: `/ws`
 * is the app-server protocol with its own framing, and this is an opaque
 * passthrough to Steel. Sharing one path would mean one handler guessing which
 * protocol a connection meant.
 */
export function attachLiveView(
  wss: WebSocketServer,
  options: LiveViewOptions,
): { handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean } {
  const steelApiUrl = options.steelApiUrl ?? process.env["REAPER_STEEL_API_URL"] ?? DEFAULT_STEEL_API_URL;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return {
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? "/", "http://localhost");
      /*
       * The thread id is a *path segment*, not a query parameter, and that is
       * load-bearing rather than cosmetic.
       *
       * Steel's viewer builds its socket URLs by appending to a base: it asks
       * for the tab list with `${base}?tabInfo=true` and for a page with
       * `${base}?pageId=<id>`. A base that already carried `?threadId=...`
       * therefore produced `?threadId=...?tabInfo=true`, which parses as the
       * single parameter `threadId` with the value `...?tabInfo=true`. The
       * thread id was wrong, so the socket was refused, and the viewer sat on
       * "Session connecting" forever with no error to explain it.
       *
       * As a path segment the query Steel appends is the only query, so both
       * forms arrive intact. The query form is still accepted for the pane's own
       * direct use, which is what its tests exercise.
       */
      const prefix = "/api/live/";
      const fromPath = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : undefined;
      if (url.pathname !== "/api/live" && fromPath === undefined) return false;

      const threadId = fromPath ?? url.searchParams.get("threadId");
      if (!threadId) {
        socket.destroy();
        return true;
      }
      const pageId = url.searchParams.get("pageId");
      const tabInfo = url.searchParams.get("tabInfo") === "true";

      wss.handleUpgrade(request, socket, head, (client) => {
        if (tabInfo) void serveTabList(client, threadId);
        else void bridgePage(client, threadId, pageId);
      });
      return true;
    },
  };

  /** Send a typed refusal and close, rather than a bare close code. */
  function refuse(client: WebSocket, failure: LiveViewFailure, detail: string): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "error", reason: failure, detail }));
      client.close(1000, "no live page");
    }
  }

  /**
   * The tab list, built from this thread's own pages.
   *
   * Steel's own tab discovery reports every page in the browser, which is every
   * thread's tabs. So the list is not asked for from Steel: it is assembled
   * from `pageTargets()`, which reads the one context this thread owns. A tab
   * the viewer can see is therefore a tab this thread can drive, and there is no
   * page id in the list that names somebody else's page.
   *
   * The socket is kept open and re-sent on an interval, because the viewer
   * expects a live list: opening or closing a tab in the agent's own program
   * changes this thread's pages, and a one-shot list would leave the strip
   * showing tabs that are gone.
   */
  async function serveTabList(client: WebSocket, threadId: string): Promise<void> {
    const runtime = options.threadBrowsers.forThread(threadId);
    const send = async (): Promise<void> => {
      if (client.readyState !== WebSocket.OPEN) return;
      const pages = await runtime.pageTargets().catch(() => []);
      client.send(JSON.stringify({
        type: "tabList",
        tabs: pages.map((entry) => ({
          id: entry.targetId,
          url: entry.url,
          title: entry.title || entry.name || entry.url,
          // The viewer renders a favicon slot; a null is what it expects for
          // "none", and inventing one would point at a URL that 404s.
          favicon: null,
        })),
        firstTabId: (pages.find((entry) => entry.active) ?? pages[0])?.targetId ?? null,
      }));
    };
    await send();
    /*
     * Re-sent on an interval so the strip tracks the agent.
     *
     * Two things change under the viewer: the set of pages (the agent opens or
     * closes tabs) and which one is active (the agent switches pages). The list
     * carries both, `firstTabId` being the active page, and the viewer's own
     * `handleTabList` only promotes a tab when nothing is active. So the active
     * page is also sent as its own message, which the small script injected
     * into the viewer reads to follow the agent.
     *
     * Not a per-event push: the runtime has no change feed for "the active page
     * moved", and a two-second poll is cheaper than adding one, while being
     * well under the time it takes a person to notice the strip is a beat
     * behind.
     */
    const timer = setInterval(() => {
      void send().then(async () => {
        if (client.readyState !== WebSocket.OPEN) return;
        const pages = await runtime.pageTargets().catch(() => []);
        const active = pages.find((entry) => entry.active);
        if (active) client.send(JSON.stringify({ type: "activeTab", pageId: active.targetId }));
      });
    }, 2_000);
    timer.unref?.();
    client.on("close", () => clearInterval(timer));
    client.on("error", () => clearInterval(timer));
  }

  /**
   * One page's frames and input, bridged to Steel.
   *
   * The page id is *validated against this thread's own pages* before any
   * upstream socket is opened. That check is the whole reason this function
   * exists rather than pointing the viewer at Steel: without it, a client could
   * pass any target id and stream any tab in the browser, including another
   * thread's. A page id that is not in this thread's list is refused, and the
   * refusal says so rather than falling back to the active page, because a
   * silent fallback is how a viewer ends up showing the wrong tab while looking
   * like it worked.
   */
  async function bridgePage(client: WebSocket, threadId: string, pageId: string | null): Promise<void> {
    const runtime = options.threadBrowsers.forThread(threadId);

    let targetId = pageId;
    if (targetId === null) {
      const resolved = await resolveThreadPageTarget(options.threadBrowsers, threadId);
      if ("failure" in resolved) {
        refuse(client, resolved.failure, resolved.detail);
        return;
      }
      targetId = resolved.targetId;
    } else if (!(await runtime.ownsTarget(targetId).catch(() => false))) {
      refuse(client, "no-page", "that page does not belong to this thread");
      return;
    }

    let upstream: WebSocket;
    try {
      upstream = await openSteelCast(steelApiUrl, targetId, connectTimeoutMs);
    } catch (error) {
      refuse(client, "upstream-unreachable", `the browser stream is not reachable: ${(error as Error).message}`);
      return;
    }

    /*
     * A byte pump in both directions, and the teardown is symmetric so neither
     * side is left holding a socket the other has given up on. Closing only one
     * way leaks the other: the viewer socket stays open after Steel has gone,
     * or Steel keeps screencasting to a browser nobody is watching.
     */
    const closeBoth = (code: number, reason: string): void => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason);
      }
    };

    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("message", (data) => {
      /*
       * Input is forwarded only when the human owns the browser.
       *
       * The UI blocks clicks with an overlay, but that is the weaker lock and
       * it is on the far side of the wire: this is where the rule is actually
       * enforced. A message from a viewer whose lease is not human-owned is
       * dropped rather than forwarded, so a stale tab, a script, or a UI bug
       * cannot drive a browser the agent is using.
       */
      if (runtime.controlLease().owner !== "human") return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false });
    });

    upstream.on("close", () => closeBoth(1000, "upstream closed"));
    client.on("close", () => closeBoth(1000, "viewer closed"));
    upstream.on("error", () => closeBoth(1011, "upstream error"));
    client.on("error", () => closeBoth(1011, "viewer error"));
  }
}
