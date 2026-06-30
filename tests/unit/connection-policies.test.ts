import test from "node:test";
import assert from "node:assert/strict";

import { ConnectionPolicyError } from "../../src/connection/errors.js";
import {
  enforceConnectionPolicies,
  InMemoryRateLimiter,
  parseConnectionPolicies,
} from "../../src/connection/policies.js";
import { createValidRequestEnvelope } from "../fixtures/phase0.js";

test("allows anonymous requests by default", () => {
  const policies = parseConnectionPolicies({});
  const rateLimiter = new InMemoryRateLimiter(10, 1_000, { now: () => 0 });

  assert.doesNotThrow(() => enforceConnectionPolicies(createValidRequestEnvelope(), policies, rateLimiter));
});

test("rejects requests without bearer token when auth is required", () => {
  const policies = parseConnectionPolicies({
    auth: {
      allowAnonymous: false,
      bearerTokens: ["secret"],
    },
  });
  const rateLimiter = new InMemoryRateLimiter(10, 1_000, { now: () => 0 });

  assert.throws(
    () => enforceConnectionPolicies(createValidRequestEnvelope(), policies, rateLimiter),
    (error: unknown) => error instanceof ConnectionPolicyError && error.code === "AUTH_REQUIRED",
  );
});

test("rejects invalid bearer tokens", () => {
  const request = createValidRequestEnvelope();
  request.metadata.authorization = "Bearer wrong";
  const policies = parseConnectionPolicies({
    auth: {
      allowAnonymous: false,
      bearerTokens: ["secret"],
    },
  });
  const rateLimiter = new InMemoryRateLimiter(10, 1_000, { now: () => 0 });

  assert.throws(
    () => enforceConnectionPolicies(request, policies, rateLimiter),
    (error: unknown) => error instanceof ConnectionPolicyError && error.code === "AUTH_INVALID",
  );
});

test("rejects payloads that exceed the configured byte limit", () => {
  const request = createValidRequestEnvelope();
  request.payload.prompt = "x".repeat(500);
  const policies = parseConnectionPolicies({ maxPayloadBytes: 40 });
  const rateLimiter = new InMemoryRateLimiter(10, 1_000, { now: () => 0 });

  assert.throws(
    () => enforceConnectionPolicies(request, policies, rateLimiter),
    (error: unknown) => error instanceof ConnectionPolicyError && error.code === "PAYLOAD_TOO_LARGE",
  );
});

test("rejects requests with too many attachments", () => {
  const request = createValidRequestEnvelope();
  request.payload.attachments = [
    { id: "1", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 },
    { id: "2", name: "b.txt", mimeType: "text/plain", sizeBytes: 1 },
  ];
  const policies = parseConnectionPolicies({ maxAttachments: 1 });
  const rateLimiter = new InMemoryRateLimiter(10, 1_000, { now: () => 0 });

  assert.throws(
    () => enforceConnectionPolicies(request, policies, rateLimiter),
    (error: unknown) => error instanceof ConnectionPolicyError && error.code === "TOO_MANY_ATTACHMENTS",
  );
});

test("rejects requests with too many artifact references", () => {
  const request = createValidRequestEnvelope();
  request.payload.artifactRefs = [
    { artifactId: "1", kind: "tool_output" },
    { artifactId: "2", kind: "tool_output" },
  ];
  const policies = parseConnectionPolicies({ maxArtifactRefs: 1 });
  const rateLimiter = new InMemoryRateLimiter(10, 1_000, { now: () => 0 });

  assert.throws(
    () => enforceConnectionPolicies(request, policies, rateLimiter),
    (error: unknown) => error instanceof ConnectionPolicyError && error.code === "TOO_MANY_ARTIFACT_REFS",
  );
});

test("rate limits repeated requests in the configured window", () => {
  const policies = parseConnectionPolicies({
    rateLimit: {
      maxRequests: 1,
      windowMs: 1_000,
    },
  });
  let now = 0;
  const rateLimiter = new InMemoryRateLimiter(1, 1_000, { now: () => now });
  const request = createValidRequestEnvelope();

  enforceConnectionPolicies(request, policies, rateLimiter);

  assert.throws(
    () => enforceConnectionPolicies(request, policies, rateLimiter),
    (error: unknown) => error instanceof ConnectionPolicyError && error.code === "RATE_LIMITED",
  );

  now = 1_001;
  assert.doesNotThrow(() => enforceConnectionPolicies(request, policies, rateLimiter));
});
