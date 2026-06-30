import test from "node:test";
import assert from "node:assert/strict";

import { SessionGateway, type AgentTurnHandler } from "../../src/connection/session-gateway.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";

test("session resume returns the last emitted events", async () => {
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
  const resumed = await gateway.handleRequest(
    {
      ...request,
      request_id: "request-2",
      message_type: "session_resume",
      payload: {},
    },
    "http_json",
  );

  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.events[0]!.message_type, "assistant_message");
});

test("cancelling an active request aborts the running turn", async () => {
  let enteredWait: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredWait = resolve;
  });

  const handler: AgentTurnHandler = async function* (request, context) {
    yield {
      ...request,
      message_type: "assistant_delta",
      timestamp: request.timestamp,
      payload: { content: "working" },
    };
    enteredWait?.();
    await new Promise<void>((resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };

  const gateway = new SessionGateway(handler, undefined, { now: () => Date.now() });
  const request = createValidRequestEnvelope();

  const active = gateway.handleRequest(request, "websocket");
  await entered;
  const cancellation = await gateway.handleRequest(
    {
      ...request,
      request_id: "request-cancel",
      message_type: "cancel_request",
      payload: {},
    },
    "websocket",
  );
  const activeResult = await active;

  assert.equal(cancellation.status, "cancelled");
  assert.equal(activeResult.status, "cancelled");
  assert.equal(activeResult.events[0]!.payload.code, "REQUEST_CANCELLED");
});

test("request timeout converts to a timeout error event", async () => {
  const handler: AgentTurnHandler = async function* (request) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    yield {
      ...request,
      message_type: "assistant_message",
      timestamp: request.timestamp,
      payload: { content: "late" },
    };
  };

  const gateway = new SessionGateway(handler, {
    auth: { allowAnonymous: true, bearerTokens: [] },
    rateLimit: { maxRequests: 10, windowMs: 1_000 },
    maxPayloadBytes: 64 * 1024,
    requestTimeoutMs: 5,
    maxAttachments: 8,
    maxArtifactRefs: 8,
  });

  const result = await gateway.handleRequest(createValidRequestEnvelope(), "http_json");
  assert.equal(result.status, "cancelled");
  assert.equal(result.events[0]!.payload.code, "REQUEST_TIMEOUT");
});
