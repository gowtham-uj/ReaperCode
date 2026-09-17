/**
 * Same-origin proxy for the preview pane.
 *
 * A dev server the agent started listens on `127.0.0.1:<port>`. An iframe
 * pointed straight at it is cross-origin, so the parent page cannot read its
 * title, cannot know when it navigated, and — on a hardened setup — may not be
 * allowed to frame it at all. Proxying through the BFF puts the preview on the
 * BFF's own origin, which is the whole reason this file exists.
 *
 * ## What this does and does not widen
 *
 * The BFF binds loopback, and the app-server it fronts has no auth token, so
 * anything that can reach the BFF can already make the agent run arbitrary
 * commands. Proxying an arbitrary *loopback* port is therefore not a privilege
 * increase over what the caller already has. What would be an increase is
 * proxying somewhere else, so:
 *
 * - the target host is hardcoded to `127.0.0.1` and is never taken from the
 *   request. There is no `?host=` and no absolute-URL form.
 * - the port must be unprivileged. Below 1024 is a system service, not a dev
 *   server, and forwarding to one is never what the user meant.
 * - hop-by-hop and auth headers are stripped in both directions, so a cookie
 *   or bearer token for the BFF's origin is not replayed into the dev server,
 *   and a `Set-Cookie` from the dev server does not land on the BFF's origin.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import { reservedLoopbackPorts } from "./reserved-ports.js";

const PREVIEW_PREFIX = "/preview/";

/**
 * Ports the proxy refuses even before the caller narrows them, covering the
 * case where a caller proxies a preview without naming its own endpoints.
 *
 * Chrome's devtools port is the one that matters here and it is a constant
 * because it is Chrome's, not Reaper's: it is listening whenever a browser is,
 * regardless of which endpoint the browser attaches through. The Steel API
 * port is added by the gateway from the configured endpoint, since that one
 * Reaper owns and it can move.
 */
const ALWAYS_RESERVED_PORTS = reservedLoopbackPorts({});

/**
 * Headers that describe a single connection rather than the message, plus the
 * credential headers. Forwarding these breaks framing or leaks authority.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  // The dev server's own framing policy is about *its* origin; keeping it would
  // block the very iframe this proxy exists to make work.
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
]);

export interface PreviewTarget {
  port: number;
  /** Path and query to request from the dev server, always starting with "/". */
  path: string;
}

/**
 * Parse `/preview/<port>/<rest>` into a target, or return undefined when the
 * path is not a preview request or names a port that must not be proxied.
 */
export function parsePreviewPath(
  rawUrl: string,
  reservedPorts: ReadonlySet<number> = ALWAYS_RESERVED_PORTS,
): PreviewTarget | undefined {
  const url = new URL(rawUrl, "http://localhost");
  if (!url.pathname.startsWith(PREVIEW_PREFIX)) return undefined;

  const remainder = url.pathname.slice(PREVIEW_PREFIX.length);
  const slash = remainder.indexOf("/");
  const portText = slash === -1 ? remainder : remainder.slice(0, slash);
  // `Number` rather than `parseInt`: "80abc" must not be read as port 80.
  const port = Number(portText);
  if (!/^\d{2,5}$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65_535) {
    return undefined;
  }
  /*
   * Two ports are refused outright, and they are the two that matter.
   *
   * The port range check above bounds *how many* ports this reaches and not
   * which, and the interesting services all sit above 1024. Measured before
   * this: `/preview/9222/json/version` returned the shared Chrome's CDP
   * descriptor, and `/preview/4180/healthz` returned the gateway's own health,
   * so the proxy reached both the browser every thread shares and the server
   * serving the page. Anything that can fetch from this gateway can reach those
   * two, which is why naming them is worth more than narrowing the range.
   *
   * A denylist rather than an allowlist of "ports the agent started", because
   * the honest set of dev-server ports is not knowable here: a project picks
   * its own, and refusing a legitimate one would break the pane this proxy
   * exists for. The ones with no legitimate preview use are the ports Reaper's
   * own services listen on, and those are passed in rather than written down
   * so they follow the configuration. See `reserved-ports.ts`.
   */
  if (reservedPorts.has(port)) return undefined;

  const rest = slash === -1 ? "/" : remainder.slice(slash);
  return { port, path: `${rest || "/"}${url.search}` };
}

/**
 * Proxy one request to `127.0.0.1:<port>`. Errors are reported as 502 with a
 * readable body rather than a bare socket hangup — "the dev server is not
 * running yet" is the single most common state this hits, and the iframe
 * needs to be able to say so.
 */
export function proxyPreview(
  target: PreviewTarget,
  incoming: IncomingMessage,
  response: ServerResponse,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // Some dev servers (Vite) reject requests whose Host does not match what they
  // expect, so it is set explicitly rather than merely dropped.
  headers.host = `127.0.0.1:${target.port}`;

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: target.port,
      method: incoming.method ?? "GET",
      path: target.path,
      headers,
    },
    (upstreamResponse) => {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue;
        if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
        out[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, out);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", (error: NodeJS.ErrnoException) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const reason = error.code === "ECONNREFUSED"
      ? `Nothing is listening on port ${target.port} yet.`
      : `Could not reach the server on port ${target.port}: ${error.message}`;
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(reason);
  });

  incoming.pipe(upstream);
}
