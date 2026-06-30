import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "../../../src/adaptive/redact.js";

test("redactSecrets handles AWS keys", () => {
  const out = redactSecrets("AKIAIOSFODNN7EXAMPLE");
  assert.equal(out.redacted, "[REDACTED:aws-access-key]");
  assert.equal(out.redactions.length, 1);
  assert.equal(out.redactions[0]!.reason, "aws-access-key");
});

test("redactSecrets handles OpenAI keys", () => {
  const out = redactSecrets("sk-1234567890abcdefghijklmnopqrstuvwxyz");
  assert.equal(out.redacted, "[REDACTED:openai-key]");
  assert.equal(out.redactions.length, 1);
});

test("redactSecrets handles GitHub tokens", () => {
  const out = redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  assert.equal(out.redacted, "[REDACTED:github-token]");
});

test("redactSecrets handles PEM private keys", () => {
  const out = redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----");
  assert.equal(out.redacted, "[REDACTED:private-key]");
});

test("redactSecrets handles bearer tokens", () => {
  const out = redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz1234567890");
  assert.equal(out.redacted, "Bearer [REDACTED:bearer]");
});

test("redactSecrets handles env-style secret assignments", () => {
  const out = redactSecrets("PASSWORD=hunter2hunter2\n");
  assert.match(out.redacted, /PASSWORD=\[REDACTED\]/);
});

test("redactSecrets handles connection strings", () => {
  const out = redactSecrets("postgres://user:secretpw@host:5432/db");
  assert.match(out.redacted, /:\[REDACTED:password\]@/);
});

test("redactSecrets preserves non-secret text", () => {
  const out = redactSecrets("hello world, this has no secrets in it");
  assert.equal(out.redacted, "hello world, this has no secrets in it");
  assert.equal(out.redactions.length, 0);
});
