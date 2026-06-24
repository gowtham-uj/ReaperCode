import test from "node:test";
import assert from "node:assert/strict";

import { classifyModelError } from "../../src/model/error-taxonomy.js";

test("classifies exhausted provider balance as provider unavailable with fallback", () => {
  const error = new Error('HTTP 402 {"error":{"message":"Insufficient Balance"}}') as Error & { status?: number };
  error.status = 402;

  const result = classifyModelError(error);

  assert.equal(result.kind, "provider_unavailable");
  assert.equal(result.retryable, false);
  assert.equal(result.suggestsFallback, true);
});

test("classifies transport and timeout failures as fallback-worthy retryable errors", () => {
  const transport = classifyModelError(new Error("fetch failed: ECONNREFUSED"));
  const timeout = classifyModelError(new Error("Model call timed out after 300000ms"));

  assert.equal(transport.kind, "transport");
  assert.equal(transport.retryable, true);
  assert.equal(transport.suggestsFallback, true);
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.suggestsFallback, true);
});
