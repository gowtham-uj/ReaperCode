import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMainAgentTransportError,
  countConsecutiveModelTransportBlockers,
  mainAgentTransportRetryLimit,
} from "../../src/runtime/engine.js";

test("classifyMainAgentTransportError recognizes provider 429 as retryable transport", () => {
  const error = new Error('LiteLLM generate request failed with status 429 provider=minimax body={"type":"error","error":{"type":"rate_limit_error"}}') as Error & { status?: number };
  error.status = 429;
  const result = classifyMainAgentTransportError(error);
  assert.equal(result?.code, "main_agent_transport_error");
  assert.match(result?.message ?? "", /rate_limit/);
  assert.ok(result?.details.some((line) => line.includes("status=429")));
});

test("classifyMainAgentTransportError recognizes 5xx and network failures", () => {
  assert.equal(classifyMainAgentTransportError(Object.assign(new Error("HTTP 503 overloaded"), { status: 503 }))?.code, "main_agent_transport_error");
  assert.equal(classifyMainAgentTransportError(new Error("fetch failed: ECONNRESET"))?.code, "main_agent_transport_error");
  assert.equal(classifyMainAgentTransportError(new Error("request timed out"))?.code, "main_agent_transport_error");
});

test("classifyMainAgentTransportError ignores malformed model output/schema failures", () => {
  assert.equal(classifyMainAgentTransportError(new Error("tool_calls[0]: name: Required")), undefined);
  assert.equal(classifyMainAgentTransportError(new Error("JSON parse error in assistant response")), undefined);
});

test("countConsecutiveModelTransportBlockers stops at non-model blockers", () => {
  assert.equal(
    countConsecutiveModelTransportBlockers([
      { source: "model", code: "main_agent_transport_error" },
      { source: "model", code: "main_agent_transport_error" },
    ]),
    2,
  );
  assert.equal(
    countConsecutiveModelTransportBlockers([
      { source: "model", code: "main_agent_transport_error" },
      { source: "schema", code: "main_agent_schema_error" },
      { source: "model", code: "main_agent_transport_error" },
    ]),
    1,
  );
});

test("mainAgentTransportRetryLimit defaults to two provider attempts", () => {
  assert.equal(mainAgentTransportRetryLimit(), 2);
});

/*
 * An account failure must not be reported as "send it again".
 *
 * A long, tool-heavy turn died with DeepSeek's "HTTP 402 — Insufficient
 * Balance", which was unclassified and fell through to the generic
 * `model_call_failed` message: "Send the message again, or switch models".
 * Neither action can help an account that is out of credit, so the user retries
 * and watches the same failure repeat. These cases name the account cause and
 * say what actually fixes it; every retryable case still classifies as
 * transport, so the honesty does not cost the retry path.
 */
test("classifyAccountError recognizes an exhausted balance and says what fixes it", async () => {
  const { classifyAccountError } = await import("../../src/runtime/engine.js");

  const balance = classifyAccountError(
    new Error('DeepSeek stream request failed: HTTP 402 — {"error":{"message":"Insufficient Balance"}}'),
  );
  assert.equal(balance?.code, "provider_account_error");
  assert.match(balance?.message ?? "", /out of credit or quota/i);
  assert.match(balance?.message ?? "", /[Tt]op up/);
  assert.doesNotMatch(balance?.message ?? "", /[Ss]end the message again, or switch models/);

  // A revoked key is the same class: terminal, and fixed in Settings.
  assert.equal(classifyAccountError(Object.assign(new Error("Forbidden"), { status: 403 }))?.code, "provider_account_error");
});

test("a 402 text without a real status is still recognized, and retryable errors are not", async () => {
  const { classifyAccountError, classifyMainAgentTransportError } = await import("../../src/runtime/engine.js");

  assert.equal(classifyAccountError(new Error("Insufficient Balance"))?.code, "provider_account_error");

  // The retryable classes must NOT be reclassified as account errors.
  assert.equal(classifyAccountError(Object.assign(new Error("HTTP 429 rate limit"), { status: 429 })), undefined);
  assert.equal(classifyAccountError(new Error("HTTP 503 overloaded")), undefined);
  const retry = classifyMainAgentTransportError(Object.assign(new Error("HTTP 429 rate limit"), { status: 429 }));
  assert.equal(retry?.code, "main_agent_transport_error");
});
