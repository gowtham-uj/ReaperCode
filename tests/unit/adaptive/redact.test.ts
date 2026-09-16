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

/*
 * A credential-shaped env assignment is caught whatever the vendor is called.
 *
 * The pattern used to anchor its alternatives with `\b`, which is wrong for the
 * commonest form of all: `_` is a word character, so there is no boundary in
 * `ANTHROPIC_AUTH_TOKEN` and the name slipped through verbatim. The audit found
 * the running app-server's own token in a trajectory after a validation command
 * printed it, and this is why the redactor did not remove it.
 *
 * The names below are the real ones from this deployment's `.env`, not invented
 * shapes, because the case that leaked is the case under test.
 */
test("redactSecrets catches vendor-prefixed credential assignments", () => {
  const samples = [
    "ANTHROPIC_AUTH_TOKEN=cpa_abcdefghijklmnop123456",
    "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop12345",
    "DEEPSEEK_API_KEY=sk-1234567890abcdef",
    "MY_APP_CLIENT_SECRET=supersecretvalue123",
    "OPENROUTER_API_KEY=sk-or-v1-abcdef123456",
    "GITHUB_PRIVATE_ACCESS_TOKEN=abc123456",
    // A digit suffix on the name must not defeat it either.
    "NURALWATT_API_KEY2=zzz111222333",
    "SOME_CREDENTIAL=value123456",
  ];
  for (const sample of samples) {
    assert.notEqual(redactSecrets(sample).redacted, sample, `${sample.slice(0, 30)}... must be redacted`);
  }
});

/*
 * The counterpart, so the wider pattern cannot be widened into uselessness: a
 * sentence that happens to contain one of the words is not a credential.
 */
test("redactSecrets leaves ordinary prose alone", () => {
  for (const sample of [
    "the secret to good code is small functions",
    "there is no TOKEN here",
    "set PASSWORD=short",
  ]) {
    assert.equal(redactSecrets(sample).redacted, sample, `${JSON.stringify(sample)} must survive`);
  }
});
