import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAgentEventEnvelope,
  parseAgentRequestEnvelope,
} from "../../src/connection/schemas.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";
import { assertZodIssue } from "../fixtures/zod-issues.js";

test("parses a valid agent request envelope", () => {
  const envelope = parseAgentRequestEnvelope(createValidRequestEnvelope());

  assert.equal(envelope.message_type, "user_prompt");
});

test("rejects request envelopes with event-only message types", () => {
  const envelope = {
    ...createValidRequestEnvelope(),
    message_type: "assistant_message",
  };

  assertZodIssue(() => parseAgentRequestEnvelope(envelope), {
    code: "invalid_value",
    path: "message_type",
  });
});

test("rejects missing identifiers in request envelopes", () => {
  const envelope = createValidRequestEnvelope();
  envelope.request_id = "";

  assertZodIssue(() => parseAgentRequestEnvelope(envelope), {
    code: "too_small",
    path: "request_id",
  });
});

test("rejects invalid timestamps in request envelopes", () => {
  const envelope = createValidRequestEnvelope();
  envelope.timestamp = "not-a-date";

  assertZodIssue(() => parseAgentRequestEnvelope(envelope), {
    code: "invalid_format",
    path: "timestamp",
    format: "datetime",
  });
});

test("parses a valid agent event envelope", () => {
  const event = parseAgentEventEnvelope({
    ...createValidRequestEnvelope(),
    message_type: "tool_call_completed",
    payload: {
      tool: "file_view",
      status: "completed",
    },
  });

  assert.equal(event.message_type, "tool_call_completed");
});

test("rejects event envelopes with request-only message types", () => {
  assertZodIssue(
    () =>
      parseAgentEventEnvelope({
        ...createValidRequestEnvelope(),
        message_type: "cancel_request",
      }),
    { code: "invalid_value", path: "message_type" },
  );
});

test("rejects extra keys to keep the envelope contract frozen", () => {
  const envelope = {
    ...createValidRequestEnvelope(),
    extra: true,
  };

  assert.throws(() => parseAgentRequestEnvelope(envelope), /Unrecognized key/);
});
