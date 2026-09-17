/**
 * The one endpoint the browser tool is allowed to attach to.
 *
 * Reaper does not launch Chrome and does not talk to Chrome. Steel runs Chrome
 * as its child and proxies CDP on its own API port, and Steel's own session
 * object says where: `websocketUrl`, built by `getBaseUrl("ws")` from the host
 * and API port. In `vendor/steel-browser/api/src/plugins/browser-socket/` the
 * upgrade handler matches one of Steel's own paths (the cast socket, the
 * extension routes) and otherwise falls through to `cdpService.proxyWebSocket`,
 * so the bare root of that port *is* Steel's managed CDP proxy.
 *
 * The other two ports on the same host are ways around it:
 *
 *   `:9222`  Chrome's own remote-debugging port. Steel is reachable on this
 *            host only because it runs Chrome locally, so 9222 answers, and
 *            attaching there skips Steel entirely. Everything Steel does on
 *            the way past — session bookkeeping, the proxy that keeps one
 *            browser coherent across reconnects, the cast socket the live pane
 *            builds on — is silently bypassed, and the failure shows up later
 *            as a pane that will not stream or a session that will not release.
 *
 *   `:9223`  Steel's CDP redirect port (`CDP_REDIRECT_PORT` in its env), a hop
 *            that forwards to 9222 inside Steel's own container. It is Steel's
 *            number, but it is not Steel's managed endpoint: it ends at raw
 *            Chrome just the same.
 *
 * So the rule is one line, and it is worth stating as a rule because the
 * default already moved once: the configured endpoint is a Steel endpoint, and
 * a port that is Chrome's rather than Steel's is refused rather than used. A
 * deployment that genuinely runs a bare Chrome with no Steel is not a
 * deployment this browser tool supports, and the error says so at startup
 * instead of producing a thread that half-works.
 */

/** Chrome's remote-debugging port, and Steel's redirect hop to it. */
const CHROME_PORTS: ReadonlySet<number> = new Set([9222, 9223]);

/** Steel's API port, which is also where its CDP proxy listens. */
export const STEEL_DEFAULT_PORT = 3000;

export class NotSteelEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSteelEndpointError";
  }
}

/**
 * The port a URL names, or undefined when it names none.
 *
 * A URL with no port uses the scheme default (80/443), which is never Steel's
 * API port, so undefined here means "not one of the ports we know", not "safe".
 * The caller decides what to do with that.
 */
function portOf(raw: string | undefined): number | undefined {
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

/**
 * Whether an endpoint is Chrome's own or Steel's redirect to it.
 *
 * Callers use this to keep the two apart without repeating the port numbers:
 * the preview proxy refuses to forward to them, and the attach path refuses to
 * connect to them.
 */
export function isRawChromeEndpoint(raw: string | undefined): boolean {
  const port = portOf(raw);
  return port !== undefined && CHROME_PORTS.has(port);
}

/**
 * Refuse a browser endpoint that is not Steel's managed one.
 *
 * Throws rather than coercing. Rewriting a raw-Chrome URL to Steel's port
 * would appear to fix the configuration while leaving the operator believing
 * they are pointed somewhere they are not, and the two are not
 * interchangeable: `:9222` is a different listener with a different protocol
 * surface, not another name for `:3000`.
 *
 * A URL that names any port other than Chrome's is allowed through. Steel can
 * be configured on another port or another host, and this cannot tell a remote
 * Steel from a remote something-else; the shape it can recognise is the one
 * that is definitely wrong, and it refuses exactly that.
 */
export function assertSteelManagedEndpoint(cdpUrl: string): void {
  const port = portOf(cdpUrl);
  if (port === undefined || !CHROME_PORTS.has(port)) return;
  throw new NotSteelEndpointError(
    `REAPER_BROWSER_ENDPOINT: refusing to attach to ${cdpUrl}. ` +
      `Port ${port} is raw Chrome's debugging port, not Steel's managed endpoint. ` +
      `Reaper drives Chrome through Steel and nothing else, so a direct connection ` +
      `here would bypass the layer that owns the browser. ` +
      `Point browserCdpUrl at Steel's API port (${STEEL_DEFAULT_PORT} by default), ` +
      `or leave it unset to use the default.`,
  );
}

/**
 * Confirm the endpoint is not raw Chrome, by asking it.
 *
 * The port check above catches the common case, but it is a guess about a
 * number. Chrome answers one request that no other endpoint the browser tool
 * talks to answers: `GET /json/version` returns a JSON descriptor with a
 * `Browser` field of `Chrome/<version>`. Steel returns a 404 for that path, and
 * so does everything else. So a successful Chrome descriptor is proof the
 * endpoint is Chrome, whatever port it is on and whatever a proxy in front of
 * it does with the path.
 *
 * That makes the ban absolute rather than a list of numbers to remember: the
 * one thing this refuses is the one thing that is definitely not Steel.
 *
 * Deliberately lenient about everything else. A refused connection, a timeout,
 * a 404, an HTML body: none of those are evidence of Chrome, and treating them
 * as a refusal would break Steel Cloud behind auth, a Steel that is still
 * starting, or a self-host behind a proxy that does not forward this path. The
 * attach that follows reports those failures with their own detail; this only
 * says no to the case it can prove.
 */
export async function assertNotRawChrome(cdpUrl: string, timeoutMs = 2_000): Promise<void> {
  const origin = httpOriginOf(cdpUrl);
  if (origin === undefined) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/json/version", origin), { signal: controller.signal });
    if (!response.ok) return;
    const body = (await response.json().catch(() => undefined)) as { Browser?: unknown } | undefined;
    if (typeof body?.Browser === "string" && body.Browser.startsWith("Chrome/")) {
      throw new NotSteelEndpointError(
        `REAPER_BROWSER_ENDPOINT: refusing to attach to ${cdpUrl}. ` +
          `It answered Chrome's devtools descriptor (${body.Browser}), so it is raw Chrome, ` +
          `not Steel's managed endpoint. Reaper drives Chrome through Steel and nothing else. ` +
          `Point browserCdpUrl at Steel's API port (${STEEL_DEFAULT_PORT} by default).`,
      );
    }
  } catch (error) {
    if (error instanceof NotSteelEndpointError) throw error;
    // Unreachable, timed out, or not JSON: not evidence of Chrome. Proceed and
    // let the attach report what it finds.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The HTTP origin that serves a CDP URL's host, for the identity probe.
 *
 * `ws://host:3000` and `http://host:3000` are the same service on the same
 * port; the scheme is only about whether the socket upgrades. Returns undefined
 * for an unparseable URL, so a caller falls through to the port check rather
 * than probing a nonsense address.
 */
function httpOriginOf(cdpUrl: string): string | undefined {
  try {
    const parsed = new URL(cdpUrl);
    const scheme = parsed.protocol === "wss:" || parsed.protocol === "https:" ? "https" : "http";
    return `${scheme}://${parsed.host}`;
  } catch {
    return undefined;
  }
}
