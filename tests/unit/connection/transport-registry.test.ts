/**
 * Phase T3.14 unit tests for the transport registry.
 *
 * Covers:
 *   - `registerBuiltInAdapters` registers all five known transports.
 *   - `resolveAdapter` returns the right adapter for each transport.
 *   - `resolveAdapter` throws when no adapter is registered.
 *   - Re-registering a transport replaces the prior factory.
 *   - `listRegisteredTransportKinds` returns sorted kinds.
 *   - Lazy construction: factory runs only when resolveAdapter is called.
 *   - `_resetTransportRegistryForTests` clears all registrations.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HttpJsonAdapter,
} from "../../../src/connection/adapters/http-json.js";
import { HttpSseAdapter } from "../../../src/connection/adapters/http-sse.js";
import { StdioAdapter } from "../../../src/connection/adapters/stdio.js";
import { WebhookAdapter } from "../../../src/connection/adapters/webhook.js";
import { WebSocketAdapter } from "../../../src/connection/adapters/websocket.js";
import type { TransportKind } from "../../../src/connection/schemas.js";
import { SessionGateway } from "../../../src/connection/session-gateway.js";
import {
  _resetTransportRegistryForTests,
  listRegisteredTransportKinds,
  registerBuiltInAdapters,
  registerTransportAdapter,
  resolveAdapter,
} from "../../../src/connection/transport-registry.js";

// Build a minimal SessionGateway with a no-op handler so the
// adapters construct without trying to run a real agent loop.
const dummyGateway = new SessionGateway(async function* () {
  yield {
    connection_id: "c",
    session_id: "s",
    turn_id: "t",
    request_id: "r",
    message_type: "task_completed",
    timestamp: new Date().toISOString(),
    trace_id: "x",
    payload: {},
    metadata: {},
  };
});

test.beforeEach(() => {
  _resetTransportRegistryForTests();
});

test("registerBuiltInAdapters registers all five transports", () => {
  registerBuiltInAdapters(dummyGateway);
  const kinds = listRegisteredTransportKinds();
  assert.deepEqual(kinds, ["http_json", "http_sse", "stdio", "webhook", "websocket"]);
});

test("resolveAdapter returns the right adapter class for each transport", () => {
  registerBuiltInAdapters(dummyGateway);
  assert.ok(resolveAdapter("http_json") instanceof HttpJsonAdapter);
  assert.ok(resolveAdapter("http_sse") instanceof HttpSseAdapter);
  assert.ok(resolveAdapter("stdio") instanceof StdioAdapter);
  assert.ok(resolveAdapter("webhook") instanceof WebhookAdapter);
  assert.ok(resolveAdapter("websocket") instanceof WebSocketAdapter);
});

test("resolveAdapter returns an adapter with the right transportKind", () => {
  registerBuiltInAdapters(dummyGateway);
  for (const kind of ["http_json", "http_sse", "stdio", "webhook", "websocket"] as TransportKind[]) {
    assert.equal(resolveAdapter(kind).transportKind, kind);
  }
});

test("resolveAdapter throws when no adapter is registered for the kind", () => {
  assert.throws(
    () => resolveAdapter("http_json"),
    /no adapter registered for transport "http_json"/,
  );
});

test("resolveAdapter error message lists the kinds currently registered", () => {
  registerTransportAdapter("stdio", () => new StdioAdapter(dummyGateway));
  assert.throws(
    () => resolveAdapter("http_json"),
    /stdio/,
  );
});

test("re-registering a transport replaces the prior factory", () => {
  const original = new StdioAdapter(dummyGateway);
  const replacement = new HttpJsonAdapter(dummyGateway);
  registerTransportAdapter("stdio", () => original);
  registerTransportAdapter("stdio", () => replacement);
  assert.strictEqual(resolveAdapter("stdio"), replacement);
});

test("listRegisteredTransportKinds returns sorted kinds", () => {
  registerTransportAdapter("websocket", () => new WebSocketAdapter(dummyGateway));
  registerTransportAdapter("http_json", () => new HttpJsonAdapter(dummyGateway));
  registerTransportAdapter("stdio", () => new StdioAdapter(dummyGateway));
  assert.deepEqual(listRegisteredTransportKinds(), ["http_json", "stdio", "websocket"]);
});

test("factory is invoked lazily — not at registration time", () => {
  let factoryCalls = 0;
  registerTransportAdapter("stdio", () => {
    factoryCalls += 1;
    return new StdioAdapter(dummyGateway);
  });
  assert.equal(factoryCalls, 0, "factory should not be invoked at registration time");
  resolveAdapter("stdio");
  assert.equal(factoryCalls, 1, "factory should run on first resolve");
  resolveAdapter("stdio");
  assert.equal(factoryCalls, 2, "factory runs every time resolveAdapter is called (no memoization)");
});

test("registerBuiltInAdapters is idempotent", () => {
  registerBuiltInAdapters(dummyGateway);
  registerBuiltInAdapters(dummyGateway);
  // Should still resolve correctly — second call replaces the prior registrations.
  assert.ok(resolveAdapter("stdio") instanceof StdioAdapter);
});

test("_resetTransportRegistryForTests clears every registration", () => {
  registerBuiltInAdapters(dummyGateway);
  assert.equal(listRegisteredTransportKinds().length, 5);
  _resetTransportRegistryForTests();
  assert.equal(listRegisteredTransportKinds().length, 0);
});

test("custom transport registration works alongside built-ins", () => {
  registerBuiltInAdapters(dummyGateway);
  const customAdapter = { transportKind: "http_json" as TransportKind, handle: async () => "custom" };
  // Re-register http_json with a custom factory.
  registerTransportAdapter("http_json", () => customAdapter);
  assert.strictEqual(resolveAdapter("http_json"), customAdapter);
  // Other transports still resolve to built-ins.
  assert.ok(resolveAdapter("stdio") instanceof StdioAdapter);
});
