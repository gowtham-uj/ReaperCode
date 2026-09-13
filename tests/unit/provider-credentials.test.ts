/**
 * The credential store's one non-negotiable property: a stored key goes in and
 * never comes back out through a client-facing shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

import { ProviderCredentialStore } from "../../src/config/provider-credentials.js";

function storeInTempHome(): { store: ProviderCredentialStore; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-creds-"));
  return { store: new ProviderCredentialStore({ home }), home };
}

test("a stored key round-trips server-side but is masked for clients", () => {
  const { store, home } = storeInTempHome();
  try {
    const summary = store.set({ providerId: "anthropic", apiKey: "sk-ant-secret-value-1234" });

    assert.equal(summary.providerId, "anthropic");
    assert.equal(summary.hasKey, true);
    assert.equal(summary.keyHint, "••••1234");
    assert.ok(
      !JSON.stringify(summary).includes("sk-ant-secret-value"),
      "the summary leaked the key",
    );

    // Server-side lookup still gets the real thing — that is the whole point.
    assert.equal(store.secretFor("anthropic"), "sk-ant-secret-value-1234");

    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes("sk-ant-secret-value"), "list() leaked the key");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a short key is masked entirely rather than mostly revealed", () => {
  const { store, home } = storeInTempHome();
  try {
    const summary = store.set({ providerId: "cerebras", apiKey: "abc12345" });
    assert.equal(summary.keyHint, "••••");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the credential file is not readable by other users", () => {
  const { store, home } = storeInTempHome();
  try {
    store.set({ providerId: "openai", apiKey: "sk-openai-abcdefgh" });
    const mode = statSync(path.join(home, ".reaper", "providers.json")).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("replacing a key keeps addedAt and removing it reports whether anything went", () => {
  const { store, home } = storeInTempHome();
  try {
    const first = store.set({ providerId: "deepseek", apiKey: "sk-deepseek-oldkey11" });
    const second = store.set({ providerId: "deepseek", apiKey: "sk-deepseek-newkey22" });

    assert.equal(second.addedAt, first.addedAt, "replacing a key should not reset addedAt");
    assert.equal(store.secretFor("deepseek"), "sk-deepseek-newkey22");
    assert.equal(store.list().length, 1, "replace must not append a second entry");

    assert.equal(store.remove("deepseek"), true);
    assert.equal(store.remove("deepseek"), false, "removing twice must not claim success");
    assert.equal(store.secretFor("deepseek"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed baseUrl is rejected at the boundary", () => {
  const { store, home } = storeInTempHome();
  try {
    assert.throws(
      // A bad base URL would send the key to whatever host the string resolves
      // to, so it fails here rather than inside the HTTP client.
      () => store.set({ providerId: "openai", apiKey: "sk-x-abcdefgh", baseUrl: "not a url" }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OAuth tokens are stored server-side and only redacted status reaches clients", () => {
  const { store, home } = storeInTempHome();
  try {
    const summary = store.setOAuth({
      providerId: "oauth-fixture",
      access: "access-token-never-return-1234",
      refresh: "refresh-token-never-return-5678",
      expires: Date.now() + 60_000,
      accountId: "account@example.test",
    });
    assert.equal(summary.authType, "oauth");
    assert.equal(summary.status, "connected");
    assert.equal(summary.accountId, "account@example.test");
    assert.equal(summary.keyHint, "••••1234");
    assert.equal(store.secretFor("oauth-fixture"), "access-token-never-return-1234");
    assert.ok(!JSON.stringify(summary).includes("access-token"));
    assert.ok(!JSON.stringify(store.list()).includes("refresh-token"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an expired OAuth access token is never handed to the agent loop", () => {
  const { store, home } = storeInTempHome();
  try {
    const summary = store.setOAuth({
      providerId: "expired-oauth-fixture",
      access: "expired-access-token-never-use",
      refresh: "refresh-token-stays-server-side",
      expires: Date.now() - 1,
      enterpriseUrl: "https://enterprise.example.test",
    });
    assert.equal(summary.status, "expired");
    assert.equal(store.secretFor("expired-oauth-fixture"), undefined);
    assert.equal(store.baseUrlFor("expired-oauth-fixture"), "https://enterprise.example.test");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt credential file reads as no providers rather than throwing", async () => {
  const { home } = storeInTempHome();
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(home, ".reaper"), { recursive: true });
    writeFileSync(path.join(home, ".reaper", "providers.json"), "{ not json", "utf8");

    const store = new ProviderCredentialStore({ home });
    // A single bad byte must not break threads whose key comes from the
    // environment, so the failure mode is "nothing configured", not a throw.
    assert.deepEqual(store.list(), []);
    assert.equal(store.secretFor("anthropic"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("transport metadata carries endpoint settings but never a secret", () => {
  const { store, home } = storeInTempHome();
  try {
    store.setApi({
      providerId: "amazon-bedrock",
      key: "aws-secret-value",
      metadata: { region: "eu-central-1" },
    });

    const metadata = store.metadataFor("amazon-bedrock");
    assert.deepEqual(metadata, { region: "eu-central-1" });
    assert.ok(!JSON.stringify(metadata).includes("aws-secret-value"));
    assert.equal(store.metadataFor("never-configured"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OAuth metadata exposes the account and enterprise URL but not the tokens", () => {
  const { store, home } = storeInTempHome();
  try {
    store.setOAuth({
      providerId: "github-copilot",
      access: "access-secret-value",
      refresh: "refresh-secret-value",
      expires: Date.now() + 3_600_000,
      accountId: "acct-42",
      enterpriseUrl: "https://ghe.example.com",
    });

    const serialized = JSON.stringify(store.metadataFor("github-copilot"));
    assert.match(serialized, /acct-42/);
    assert.match(serialized, /ghe\.example\.com/);
    assert.ok(!serialized.includes("access-secret-value"));
    assert.ok(!serialized.includes("refresh-secret-value"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
