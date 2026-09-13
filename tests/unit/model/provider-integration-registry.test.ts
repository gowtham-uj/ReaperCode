import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProviderCredentialStore } from "../../../src/config/provider-credentials.js";
import { ProviderIntegrationRegistry } from "../../../src/model/provider/integration-registry.js";
import type { ProviderIntegration } from "../../../src/model/provider/types.js";

function descriptor(id: string): ProviderIntegration["descriptor"] {
  return {
    id,
    label: "Fixture Provider",
    sdkFamily: "openai-chat",
    baseUrl: "https://example.invalid/v1",
    envVar: "FIXTURE_PROVIDER_TEST_KEY",
    keyHint: "test",
    defaultModel: "static-model",
    models: ["static-model"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 8_000,
      maxOutputTokens: 2_000,
    },
    authScheme: "bearer",
  };
}

test("API authentication is write-only and triggers post-auth model discovery", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-provider-registry-"));
  try {
    const credentials = new ProviderCredentialStore({ home });
    const integration: ProviderIntegration = {
      descriptor: descriptor("fixture-api"),
      authMethods: [{
        id: "api-key",
        type: "api",
        label: "API key",
        prompts: [{ type: "text", key: "account", message: "Account" }],
      }],
      discoverModels: async (auth) => {
        assert.equal(auth.type, "api");
        assert.equal(auth.key, "secret-api-key-1234");
        assert.equal(auth.metadata?.account, "acme");
        return [{
          id: "discovered-model",
          name: "Discovered Model",
          contextTokens: 32_000,
          supportsReasoning: true,
          supportsToolCalls: true,
        }];
      },
    };
    const registry = new ProviderIntegrationRegistry([integration], credentials);

    const connected = await registry.connectApi({
      providerId: "fixture-api",
      methodId: "api-key",
      key: "secret-api-key-1234",
      inputs: { account: "acme" },
    });

    assert.equal(connected.configured, true);
    assert.equal(connected.authType, "api");
    assert.equal(connected.modelCount, 1);
    const models = registry.listModels({ providerId: "fixture-api" });
    assert.deepEqual(models.data.map((model) => model.id), ["discovered-model"]);
    assert.equal(models.data[0]?.contextTokens, 32_000);
    assert.ok(!JSON.stringify(connected).includes("secret-api-key"));
    assert.ok(!JSON.stringify(registry.list()).includes("secret-api-key"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OAuth code flow stores tokens only after successful completion", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-provider-oauth-"));
  try {
    const credentials = new ProviderCredentialStore({ home });
    const integration: ProviderIntegration = {
      descriptor: descriptor("fixture-oauth"),
      authMethods: [{
        id: "browser-login",
        type: "oauth",
        label: "Sign in with browser",
        authorize: async () => ({
          url: "https://example.invalid/authorize",
          mode: "code",
          instructions: "Sign in, then paste the authorization code.",
          complete: async (code) => code === "valid-code"
            ? {
                type: "success" as const,
                auth: {
                  type: "oauth" as const,
                  access: "oauth-access-secret-1234",
                  refresh: "oauth-refresh-secret-5678",
                  expires: Date.now() + 60_000,
                  accountId: "user-42",
                },
              }
            : { type: "failed" as const, message: "Invalid authorization code" },
        }),
      }],
    };
    const registry = new ProviderIntegrationRegistry([integration], credentials);
    const attempt = await registry.beginOAuth({
      providerId: "fixture-oauth",
      methodId: "browser-login",
    });

    assert.equal(attempt.mode, "code");
    assert.equal(credentials.secretFor("fixture-oauth"), undefined);
    const result = await registry.completeOAuth({ attemptId: attempt.attemptId, code: "valid-code" });
    assert.equal(result.status, "complete");
    assert.equal(credentials.secretFor("fixture-oauth"), "oauth-access-secret-1234");
    assert.ok(!JSON.stringify(result).includes("oauth-access-secret"));
    assert.ok(!JSON.stringify(result).includes("oauth-refresh-secret"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("OAuth refresh is single-flight and persists a rotated token", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-provider-refresh-"));
  try {
    const credentials = new ProviderCredentialStore({ home });
    credentials.setOAuth({
      providerId: "fixture-refresh",
      access: "expired-access",
      refresh: "refresh-one",
      expires: Date.now() - 1,
    });
    let refreshCalls = 0;
    const integration: ProviderIntegration = {
      descriptor: descriptor("fixture-refresh"),
      authMethods: [],
      refreshOAuth: async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          type: "oauth",
          access: "fresh-access",
          refresh: "refresh-two",
          expires: Date.now() + 60_000,
        };
      },
    };
    const registry = new ProviderIntegrationRegistry([integration], credentials);
    const [first, second] = await Promise.all([
      registry.authForRequest("fixture-refresh"),
      registry.authForRequest("fixture-refresh"),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first?.type, "oauth");
    assert.equal(first?.type === "oauth" ? first.access : undefined, "fresh-access");
    assert.deepEqual(second, first);
    assert.equal(credentials.secretFor("fixture-refresh"), "fresh-access");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-expiring OAuth credentials remain usable", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-provider-no-expiry-"));
  try {
    const credentials = new ProviderCredentialStore({ home });
    credentials.setOAuth({
      providerId: "fixture-oauth",
      access: "long-lived-token",
      refresh: "long-lived-token",
      expires: 0,
    });
    const registry = new ProviderIntegrationRegistry([{
      descriptor: descriptor("fixture-oauth"),
      authMethods: [],
    }], credentials);
    const auth = await registry.authForRequest("fixture-oauth");
    assert.equal(auth?.type === "oauth" ? auth.access : undefined, "long-lived-token");
    assert.equal(credentials.list()[0]?.status, "connected");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unsupported providers and auth methods are rejected before secret storage", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "reaper-provider-reject-"));
  try {
    const credentials = new ProviderCredentialStore({ home });
    const registry = new ProviderIntegrationRegistry([], credentials);
    await assert.rejects(
      () => registry.connectApi({ providerId: "openai", methodId: "api-key", key: "must-not-store" }),
      /Unsupported provider/,
    );
    assert.deepEqual(credentials.list(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
