/**
 * SSRF guard for the web-fetch / web-search tools.
 *
 * Rejects URLs whose host resolves to a private, loopback, link-local,
 * carrier-grade-NAT, benchmark, multicast, or cloud-metadata address. The
 * model may supply arbitrary URLs, so `redirect: "follow"` plus an
 * internal-only hostname would otherwise be a credential-exfiltration
 * primitive reaching localhost, the link-local metadata endpoint, or the
 * private network.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
];

/**
 * Resolve a URL's hostname to every IPv4/IPv6 address and reject the URL if
 * any of them is not a public, routable address. Also rejects literal
 * private/loopback/link-local IPs and obvious internal hostnames without
 * touching DNS.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`web-fetch: invalid URL ${JSON.stringify(rawUrl)}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`web-fetch: only http(s) URLs are allowed, got ${JSON.stringify(parsed.protocol)}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(`web-fetch: host ${JSON.stringify(host)} is not a public host`);
  }

  const literalIpKind = isIP(host);
  if (literalIpKind !== 0) {
    if (isPrivateIp(host, literalIpKind === 6 ? 6 : 4)) {
      throw new Error(`web-fetch: host ${JSON.stringify(host)} is a private/loopback/link-local address`);
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    throw new Error(
      `web-fetch: could not resolve host ${JSON.stringify(host)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const { address, family } of addresses) {
    const kind = family === 6 ? 6 : 4;
    if (isPrivateIp(address, kind)) {
      throw new Error(`web-fetch: host ${JSON.stringify(host)} resolves to private address ${address}`);
    }
  }
}

function isPrivateIp(address: string, family: 4 | 6): boolean {
  if (family === 4) return isPrivateIpv4(address);
  return isPrivateIpv6(address);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — treat as private
  }
  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local),
  // 172.16/12, 192.0.0.0/24, 192.168/16, 198.18/15 (benchmark), 224/4 (multicast).
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  // ::1 loopback, :: unspecified, ::ffff:x.x.x.x mapped IPv4.
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice("::ffff:".length);
    return isPrivateIpv4(v4);
  }
  // fc00::/7 unique-local, fe80::/10 link-local.
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  return false;
}
