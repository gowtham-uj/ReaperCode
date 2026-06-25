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

test("mainAgentTransportRetryLimit defaults to three provider attempts", () => {
  assert.equal(mainAgentTransportRetryLimit(), 3);
});
