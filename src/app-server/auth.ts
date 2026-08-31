import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export interface AppServerAuthOptions {
  host: string;
  authToken?: string;
  allowBrowserOrigins?: boolean;
}

export function assertSafeListener(options: AppServerAuthOptions): void {
  if (!isLoopbackHost(options.host) && !options.authToken) {
    throw new Error("Non-loopback app-server listeners require --auth-token or --auth-token-file");
  }
  if (options.authToken !== undefined && options.authToken.length < 16) {
    throw new Error("App-server auth tokens must contain at least 16 characters");
  }
}

export function authorizeUpgrade(
  request: IncomingMessage,
  options: AppServerAuthOptions,
): { ok: true } | { ok: false; status: 401 | 403; message: string } {
  if (request.headers.origin && !options.allowBrowserOrigins) {
    return { ok: false, status: 403, message: "Browser Origin headers are not accepted" };
  }
  if (!options.authToken) return { ok: true };
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "Bearer authentication required" };
  }
  const supplied = authorization.slice("Bearer ".length);
  if (!constantTimeEqual(supplied, options.authToken)) {
    return { ok: false, status: 401, message: "Invalid bearer token" };
  }
  return { ok: true };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "ip6-localhost") return true;
  if (normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
