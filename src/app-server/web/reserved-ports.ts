/**
 * The loopback ports that are Reaper's own services, not preview targets.
 *
 * The preview proxy forwards to `127.0.0.1:<port>` for any unprivileged port,
 * because the set of dev-server ports an agent might start is not knowable
 * here. That generality is the point of the proxy and also the risk: the
 * interesting services on this host are all above 1024, so "any port" reaches
 * them. Two of them are worth naming.
 *
 * `:9222` is Chrome's own devtools endpoint. Reaching it through the preview
 * proxy hands a browser client raw CDP, which can drive any thread's page
 * without going through the agent at all.
 *
 * The Steel port is worse in the same way and for the same reason: Steel's
 * cast socket (`/v1/sessions/cast`) and its session REST routes are scoped to
 * the whole browser, not to one thread, so anything that can reach them can
 * watch and drive every thread's pages. The live pane exists precisely because
 * that is too much authority to hand out, and the pane is a scoped bridge on
 * the BFF's own origin rather than a path to Steel.
 *
 * Both ports are *derived* from the configured endpoints rather than written
 * down, because they already moved once: the browser used to attach to Chrome
 * on `:9222` and now attaches to Steel's managed endpoint, which also changed
 * which port serves the unscoped socket. A denylist with those numbers
 * hardcoded would have gone stale silently. This one cannot.
 */

import { STEEL_DEFAULT_PORT } from "../../browser/steel-endpoint.js";

/**
 * Chrome's own remote-debugging port and Steel's redirect hop to it.
 *
 * The same two the browser-attach path refuses, so a port that is not a valid
 * endpoint to attach to is also not a valid preview target. Kept here rather
 * than imported as a set because the reason differs: there it is "do not
 * attach through raw Chrome", here it is "do not proxy raw Chrome to a
 * browser". Same numbers, two boundaries.
 */
const CHROME_DEVTOOLS_PORTS: ReadonlyArray<number> = [9222, 9223];

export interface ReservedPortSources {
  /** The CDP endpoint the browser attaches to. */
  cdpUrl?: string | undefined;
  /** The Steel API base URL that serves the cast socket. */
  steelApiUrl?: string | undefined;
  /** The port this gateway itself listens on. */
  gatewayPort?: number | undefined;
}

/**
 * Every loopback port the preview proxy must refuse.
 *
 * Includes an explicit port from each source, plus Chrome's devtools ports as
 * a floor: even when the browser is reached through Steel, the raw Chrome
 * endpoint underneath it is still listening on the same host and is still a
 * way around the scoping.
 */
export function reservedLoopbackPorts(sources: ReservedPortSources): ReadonlySet<number> {
  /*
   * Steel's default port is reserved even when no endpoint is named, because
   * the gateway falls back to it: the default is the port that answers when
   * nothing is configured, so it is the one a bare deployment would otherwise
   * leave open.
   */
  const ports = new Set<number>([...CHROME_DEVTOOLS_PORTS, STEEL_DEFAULT_PORT]);
  for (const raw of [sources.cdpUrl, sources.steelApiUrl]) {
    const port = explicitPort(raw);
    if (port !== undefined) ports.add(port);
  }
  if (sources.gatewayPort !== undefined && sources.gatewayPort > 0) ports.add(sources.gatewayPort);
  return ports;
}

/**
 * The port a URL names outright, or undefined.
 *
 * A URL with no port is not a wildcard: it means the scheme's default, which
 * is below 1024 and already refused by the preview proxy's range check. So an
 * empty port yields undefined rather than 80 or 443, which keeps the set free
 * of entries that can never be reached.
 */
function explicitPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.port === "") return undefined;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}
