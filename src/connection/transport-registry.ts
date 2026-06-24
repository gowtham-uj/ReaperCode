/**
 * Transport registry. Phase T3.14.
 *
 * Maps a `TransportKind` (stdio / http_json / http_sse / websocket /
 * webhook) to the adapter that serves it. The five concrete adapter
 * classes (`HttpJsonAdapter`, `HttpSseAdapter`, `WebSocketAdapter`,
 * `StdioAdapter`, `WebHookAdapter`) all wrap the same `SessionGateway`
 * but produce different output shapes:
 *
 *   - http_json  → JSON object with the full result
 *   - http_sse   → newline-delimited SSE event stream
 *   - webhook    → JSON object with a callback target
 *   - stdio      → newline-delimited JSON-RPC notifications + final response
 *   - websocket  → JSON-RPC notifications + final response (one per frame)
 *
 * Before T3.14, callers (CLI, server, tests) had to construct each
 * adapter explicitly and pick the right one based on `TransportKind`.
 * After T3.14, `resolveAdapter(transportKind)` returns the right
 * instance. The adapters are still exported individually for
 * callers that need direct construction.
 */

import { HttpJsonAdapter } from "./adapters/http-json.js";
import { HttpSseAdapter } from "./adapters/http-sse.js";
import { StdioAdapter } from "./adapters/stdio.js";
import { WebhookAdapter } from "./adapters/webhook.js";
import { WebSocketAdapter } from "./adapters/websocket.js";
import type { SessionGateway } from "./session-gateway.js";
import type { TransportKind } from "./schemas.js";

/**
 * Common shape every adapter exposes. All five adapters expose
 * `handle(input)`; the input type varies by transport (HTTP body
 * vs raw JSON-RPC string), so we type it loosely.
 *
 * `TransportAdapter` is intentionally minimal — it exists so
 * `resolveAdapter` can return a single type and callers can switch
 * on `transportKind` without juggling five distinct class types.
 */
export interface TransportAdapter {
  readonly transportKind: TransportKind;
  handle(input: unknown): Promise<unknown>;
}

const registry = new Map<TransportKind, () => TransportAdapter>();

/**
 * Register a factory for a `TransportKind`. Re-registration replaces
 * the prior factory (useful for tests + custom transports).
 *
 * The factory is invoked lazily on `resolveAdapter`, so registering
 * is cheap and the constructor (which may have side effects) only
 * runs when the adapter is actually needed.
 */
export function registerTransportAdapter(
  transportKind: TransportKind,
  factory: () => TransportAdapter,
): void {
  registry.set(transportKind, factory);
}

/**
 * Resolve the adapter for a given `TransportKind`. Throws when no
 * adapter is registered — this is a programmer error, not a user
 * error, so a clean exception is the right signal.
 */
export function resolveAdapter(transportKind: TransportKind): TransportAdapter {
  const factory = registry.get(transportKind);
  if (!factory) {
    throw new Error(
      `transport-registry: no adapter registered for transport "${transportKind}". ` +
        `Call registerTransportAdapter() at startup, or use one of the built-in: ` +
        `${listRegisteredTransportKinds().join(", ")}.`,
    );
  }
  return factory();
}

/**
 * List the transport kinds currently registered (sorted).
 */
export function listRegisteredTransportKinds(): TransportKind[] {
  return [...registry.keys()].sort() as TransportKind[];
}

/**
 * Wire the five built-in adapters. Idempotent — calling twice
 * replaces the prior registrations with the same factories.
 *
 * Callers that need to swap an adapter (e.g. for a custom SSE
 * shape) should call this first, then re-register the custom one
 * for the relevant `TransportKind`.
 */
export function registerBuiltInAdapters(gateway: SessionGateway): void {
  registerTransportAdapter("stdio", () => new StdioAdapter(gateway));
  registerTransportAdapter("http_json", () => new HttpJsonAdapter(gateway));
  registerTransportAdapter("http_sse", () => new HttpSseAdapter(gateway));
  registerTransportAdapter("websocket", () => new WebSocketAdapter(gateway));
  registerTransportAdapter("webhook", () => new WebhookAdapter(gateway));
}

/**
 * Test-only: clear the registry. Production code never needs this.
 */
export function _resetTransportRegistryForTests(): void {
  registry.clear();
}
