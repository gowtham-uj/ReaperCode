/**
 * Find the URL a dev server just printed.
 *
 * Nothing in Reaper knows what port a background command is listening on.
 * `isLikelyServerCommand` decides whether to background a command; it never
 * learns the address. But essentially every dev server announces itself on
 * stdout within the first second — Vite prints `Local: http://localhost:5173/`,
 * Next prints `- Local: http://localhost:3000`, Django prints
 * `Starting development server at http://127.0.0.1:8000/` — so the address is
 * there to be read.
 *
 * The rules this follows, and why:
 *
 * - **Loopback only.** A matched URL becomes a proxy target the browser can
 *   reach. Accepting `http://evil.test:80/` from a log line would turn any
 *   process that echoes attacker-controlled text into an SSRF primitive.
 *   Hostname is checked against a fixed loopback set, not a substring.
 * - **Unprivileged ports only.** A dev server on port 22 or 631 is not a dev
 *   server; treating it as one would offer to proxy the machine's ssh or print
 *   daemon.
 * - **No path.** Only the origin is kept. A path from a log line is untrusted
 *   input that would otherwise be appended to a proxied request.
 */

/** Hostnames that mean "this machine" and nothing else. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * Matches a bare `http(s)://host:port` prefix. Deliberately does not consume
 * the path — see the header. `\d{2,5}` keeps the port bounded so a long digit
 * run cannot make this quadratic.
 */
const URL_PATTERN = /\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{2,5})\b/g;

export interface DetectedServer {
  /** Origin only — scheme, host, port. Never a path. */
  url: string;
  port: number;
}

/**
 * Every distinct loopback origin in a chunk of process output, in first-seen
 * order. Returns an empty array for output that announces nothing, which is
 * the overwhelmingly common case — this runs on every output chunk of every
 * background process, so it does no allocation until it matches.
 */
export function detectServerUrls(text: string): DetectedServer[] {
  if (!text.includes("://")) return [];

  const found: DetectedServer[] = [];
  const seen = new Set<string>();

  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    const [, host, portText] = match;
    if (!host || !portText) continue;
    if (!LOOPBACK_HOSTS.has(host.toLowerCase())) continue;

    const port = Number(portText);
    // 1024 is where the OS stops requiring root to bind. Below it, anything
    // listening is a system service, not something the agent just started.
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) continue;

    // `0.0.0.0` is a bind address, not an address to browse to. Rewriting it
    // to localhost is what the user would do by hand anyway.
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    const scheme = match[0].startsWith("https") ? "https" : "http";
    const url = `${scheme}://${displayHost}:${port}`;

    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ url, port });
  }

  return found;
}
