import test from "node:test";
import assert from "node:assert/strict";

import { HttpJsonAdapter } from "../../src/connection/adapters/http-json.js";
import { HttpSseAdapter } from "../../src/connection/adapters/http-sse.js";
import { StdioAdapter } from "../../src/connection/adapters/stdio.js";
import { WebSocketAdapter } from "../../src/connection/adapters/websocket.js";
import { SessionGateway, type AgentTurnHandler } from "../../src/connection/session-gateway.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";

const handler: AgentTurnHandler = async function* (request) {
  yield {
    ...request,
    message_type: "assistant_delta",
    timestamp: request.timestamp,
    payload: { content: "hello" },
  };
  yield {
    ...request,
    message_type: "assistant_message",
    timestamp: request.timestamp,
    payload: { content: "hello world" },
  };
};

test("http json adapter returns normalized unary response", async () => {
  const adapter = new HttpJsonAdapter(new SessionGateway(handler));
  const result = await adapter.handle(createValidRequestEnvelope());

  assert.equal(result.status, "completed");
  assert.equal(result.events.length, 2);
  assert.equal(result.events[1]!.message_type, "assistant_message");
});

test("http sse adapter returns SSE-formatted events", async () => {
  const adapter = new HttpSseAdapter(new SessionGateway(handler));
  const result = await adapter.handle(createValidRequestEnvelope());

  assert.match(result, /event: assistant_delta/);
  assert.match(result, /event: assistant_message/);
  assert.match(result, /event: done/);
});

test("stdio adapter returns JSON-RPC notifications followed by final response", async () => {
  const adapter = new StdioAdapter(new SessionGateway(handler));
  const result = await adapter.handle(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "agent.request",
      params: createValidRequestEnvelope(),
    }),
  );

  const lines = result.split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0]!.method, "agent.event");
  assert.equal(lines[2]!.result.status, "completed");
});

test("websocket adapter returns JSON-RPC messages for the same turn", async () => {
  const adapter = new WebSocketAdapter(new SessionGateway(handler));
  const result = await adapter.handle(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "abc",
      method: "agent.request",
      params: createValidRequestEnvelope(),
    }),
  );

  const messages = result.map((line) => JSON.parse(line));
  assert.equal(messages[0]!.method, "agent.event");
  assert.equal(messages[2]!.result.status, "completed");
});
