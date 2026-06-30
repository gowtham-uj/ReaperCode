import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAgentEventEnvelope,
  parseAgentRequestEnvelope,
} from "../../src/connection/schemas.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";

test("parses a valid agent request envelope", () => {
  const envelope = parseAgentRequestEnvelope(createValidRequestEnvelope());

  assert.equal(envelope.message_type, "user_prompt");
});

test("rejects request envelopes with event-only message types", () => {
  const envelope = {
    ...createValidRequestEnvelope(),
    message_type: "assistant_message",
  };

  assert.throws(() => parseAgentRequestEnvelope(envelope), /Invalid enum value/);
});

test("rejects missing identifiers in request envelopes", () => {
  const envelope = createValidRequestEnvelope();
  envelope.request_id = "";

  assert.throws(() => parseAgentRequestEnvelope(envelope), /String must contain at least 1 character/);
});

test("rejects invalid timestamps in request envelopes", () => {
  const envelope = createValidRequestEnvelope();
  envelope.timestamp = "not-a-date";

  assert.throws(() => parseAgentRequestEnvelope(envelope), /Invalid datetime/);
});

test("parses a valid agent event envelope", () => {
  const event = parseAgentEventEnvelope({
    ...createValidRequestEnvelope(),
    message_type: "tool_call_completed",
    payload: {
      tool: "read_file",
      status: "completed",
    },
  });

  assert.equal(event.message_type, "tool_call_completed");
});

test("rejects event envelopes with request-only message types", () => {
  assert.throws(
    () =>
      parseAgentEventEnvelope({
        ...createValidRequestEnvelope(),
        message_type: "cancel_request",
      }),
    /Invalid enum value/,
  );
});

test("rejects extra keys to keep the envelope contract frozen", () => {
  const envelope = {
    ...createValidRequestEnvelope(),
    extra: true,
  };

  assert.throws(() => parseAgentRequestEnvelope(envelope), /Unrecognized key/);
});
