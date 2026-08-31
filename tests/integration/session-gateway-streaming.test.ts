import test from "node:test";
import assert from "node:assert/strict";

import { BadRequestError, NoActiveTurnError } from "../../src/connection/errors.js";
import { SessionGateway, type AgentTurnHandler } from "../../src/connection/session-gateway.js";
import { AdaptiveConnectionLayer } from "../../src/connection/adaptive.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";

test("two concurrent sessions run in parallel without a reentrancy collision", async () => {
  let release!: () => void;
  let entered = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handler: AgentTurnHandler = async function* (request) {
    entered += 1;
    await gate;
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: `done-${request.session_id}` },
    };
  };

  const gateway = new SessionGateway(handler);
  const first = gateway.handleRequest({ ...createValidRequestEnvelope(), session_id: "session-a" }, "http_json");
  const second = gateway.handleRequest({ ...createValidRequestEnvelope(), session_id: "session-b" }, "http_json");

  await waitFor(() => entered === 2);
  release();

  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.status, "completed");
  assert.equal(right.status, "completed");
});

test("same-session reentrancy is still rejected", async () => {
  let entered: (() => void) | undefined;
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const handler: AgentTurnHandler = async function* (request, context) {
    yield {
      ...request,
      message_type: "assistant_delta",
      timestamp: request.timestamp,
      payload: { content: "working" },
    };
    entered?.();
    await new Promise<void>((resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };

  const gateway = new SessionGateway(handler);
  const request = createValidRequestEnvelope();
  const active = gateway.handleRequest(request, "http_json");
  await enteredGate;

  const colliding = await gateway.handleRequest(
    { ...request, request_id: "request-reentrant" },
    "http_json",
  );
  assert.equal(colliding.status, "error");
  assert.equal(colliding.events[0]!.payload.code, "REENTRANT_QUERY");

  // Clean up: cancel the active turn so the test exits promptly.
  await gateway.handleRequest(
    { ...request, request_id: "request-cleanup", message_type: "cancel_request", payload: {} },
    "http_json",
  );
  await active;
});

test("streamRequest yields events incrementally and resolves with the final response", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    yield {
      ...request,
      message_type: "assistant_delta",
      timestamp: request.timestamp,
      payload: { content: "chunk-1" },
    };
    yield {
      ...request,
      message_type: "assistant_delta",
      timestamp: request.timestamp,
      payload: { content: "chunk-2" },
    };
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: "full" },
    };
  };

  const gateway = new SessionGateway(handler);
  const request = createValidRequestEnvelope();

  const streamed: string[] = [];
  let final;
  for await (const event of gateway.streamRequest(request, "http_json")) {
    if (event.message_type === "assistant_delta") {
      streamed.push(String(event.payload.content));
    }
  }
  final = streamed.length;

  assert.deepEqual(streamed, ["chunk-1", "chunk-2"]);
  assert.equal(final, 2);
});

test("onEvent is invoked per event with normalization applied", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    yield {
      ...request,
      message_type: "assistant_delta",
      timestamp: request.timestamp,
      payload: { content: "a" },
    };
  };

  const gateway = new SessionGateway(handler);
  const request = createValidRequestEnvelope();
  const seen: string[] = [];

  await gateway.handleRequest(request, "http_json", {
    onEvent: (event) => { seen.push(String(event.payload.content)); },
  });

  assert.deepEqual(seen, ["a"]);
});

test("resume with an out-of-range event_offset rejects with a 400-style error", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: "done" },
    };
  };
  const gateway = new SessionGateway(handler);
  const request = createValidRequestEnvelope();
  await gateway.handleRequest(request, "http_json");

  await assert.rejects(
    gateway.handleRequest(
      { ...request, request_id: "request-2", message_type: "session_resume", payload: { event_offset: 999 } },
      "http_json",
    ),
    (error: unknown) => error instanceof BadRequestError && error.code === "INVALID_EVENT_OFFSET",
  );
});

test("cancelling a session with no active turn throws NoActiveTurnError, not SessionNotFound", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: "done" },
    };
  };
  const gateway = new SessionGateway(handler);
  const request = createValidRequestEnvelope();
  await gateway.handleRequest(request, "http_json");

  await assert.rejects(
    gateway.handleRequest(
      { ...request, request_id: "request-cancel", message_type: "cancel_request", payload: {} },
      "http_json",
    ),
    (error: unknown) => error instanceof NoActiveTurnError,
  );
});

test("cancel appends the cancellation event to history instead of clobbering it", async () => {
  let entered: (() => void) | undefined;
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const handler: AgentTurnHandler = async function* (request, context) {
    yield {
      ...request,
      message_type: "assistant_delta",
      timestamp: request.timestamp,
      payload: { content: "before-cancel" },
    };
    entered?.();
    await new Promise<void>((resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };

  const gateway = new SessionGateway(handler);
  const request = createValidRequestEnvelope();
  const active = gateway.handleRequest(request, "websocket");
  await enteredGate;
  await gateway.handleRequest(
    { ...request, request_id: "request-cancel", message_type: "cancel_request", payload: {} },
    "websocket",
  );
  await active;

  const resumed = await gateway.handleRequest(
    { ...request, request_id: "request-resume", message_type: "session_resume", payload: {} },
    "websocket",
  );
  assert.equal(resumed.status, "resumed");
  // History now preserves the pre-cancel delta AND both cancellation events
  // (the cancel request's synthesized event and the running turn's terminal error).
  assert.equal(resumed.events.length, 3);
  assert.equal(resumed.events[0]!.message_type, "assistant_delta");
  assert.equal(resumed.events[1]!.payload.code, "REQUEST_CANCELLED");
  assert.equal(resumed.events[2]!.payload.code, "REQUEST_CANCELLED");
});

test("adaptive layer maps a malformed envelope to a 400 instead of a generic 500", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: "unused" },
    };
  };
  const layer = new AdaptiveConnectionLayer(new SessionGateway(handler));
  const malformed = {
    connection_id: "conn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    request_id: "request-1",
    message_type: "not_a_real_type",
    timestamp: "2026-05-05T12:00:00.000Z",
    trace_id: "trace-1",
    payload: {},
    metadata: {},
  };

  const response = await layer.handle(malformed, { transport: "http_json" });
  const body = response.body as { status: string; error: { code: number } };
  assert.equal(body.status, "error");
  assert.equal(body.error.code, 400);
});

test("adaptive layer maps nothing-to-cancel to a 409", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: "unused" },
    };
  };
  const layer = new AdaptiveConnectionLayer(new SessionGateway(handler));
  const request = createValidRequestEnvelope();
  await layer.handle(request, { transport: "http_json" });

  const cancel = await layer.handle(
    { ...request, request_id: "request-cancel", message_type: "cancel_request", payload: {} },
    { transport: "http_json" },
  );
  const body = cancel.body as { status: string; error: { code: number } };
  assert.equal(body.status, "error");
  assert.equal(body.error.code, 409);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
