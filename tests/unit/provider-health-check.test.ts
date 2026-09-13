import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHealthProbe,
  checkProviderCredential,
} from "../../src/model/provider/health-check.js";
import type { ProviderDescriptor } from "../../src/model/provider/types.js";

function descriptor(overrides: Record<string, unknown> = {}): ProviderDescriptor {
  return {
    id: "fixture",
    label: "Fixture AI",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.fixture.test/v1",
    envVar: "FIXTURE_API_KEY",
    keyHint: "",
    defaultModel: "fixture-model",
    models: ["fixture-model"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 1000,
    },
    ...overrides,
  } as unknown as ProviderDescriptor;
}

const apiAuth = { type: "api" as const, key: "sk-fixture-secret" };

test("openai-chat probes the model listing endpoint with a bearer token", () => {
  const probe = buildHealthProbe(descriptor(), apiAuth);
  assert.equal(probe?.url, "https://api.fixture.test/v1/models");
  assert.equal(probe?.headers["authorization"], "Bearer sk-fixture-secret");
});

test("anthropic-messages probes with x-api-key and a pinned API version", () => {
  const probe = buildHealthProbe(
    descriptor({ sdkFamily: "anthropic-messages", baseUrl: "https://api.anthropic.test" }),
    apiAuth,
  );
  assert.equal(probe?.url, "https://api.anthropic.test/v1/models");
  assert.equal(probe?.headers["x-api-key"], "sk-fixture-secret");
  assert.equal(probe?.headers["anthropic-version"], "2023-06-01");
});

test("a provider with no usable base URL is unsupported rather than passing", async () => {
  for (const base of ["", "${CUSTOM_ENDPOINT}/v1", "ftp://api.fixture.test"]) {
    assert.equal(buildHealthProbe(descriptor({ baseUrl: base, api: base, npm: undefined }), apiAuth), undefined);
  }
  const result = await checkProviderCredential({
    descriptor: descriptor({ baseUrl: "", api: "", npm: undefined }),
    auth: apiAuth,
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result.status, "unsupported");
});

test("a provider that only declares an npm package still gets a probe", () => {
  // Models.dev omits `api` for openai/anthropic/deepinfra and 23 others; those
  // must not degrade to "cannot be verified".
  const probe = buildHealthProbe(
    descriptor({ id: "deepinfra", baseUrl: "", api: undefined, npm: "@ai-sdk/deepinfra" }),
    apiAuth,
  );
  assert.equal(probe?.url, "https://api.deepinfra.com/v1/openai/models");

  const anthropic = buildHealthProbe(
    descriptor({ id: "anthropic", sdkFamily: "anthropic-messages", baseUrl: "", api: undefined, npm: "@ai-sdk/anthropic" }),
    apiAuth,
  );
  assert.equal(anthropic?.url, "https://api.anthropic.com/v1/models");
});

test("a 2xx listing response verifies the credential", async () => {
  const result = await checkProviderCredential({
    descriptor: descriptor(),
    auth: apiAuth,
    fetchImpl: async () => new Response("{\"data\":[]}", { status: 200 }),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.providerId, "fixture");
});

test("401 and 403 report a rejected credential", async () => {
  for (const status of [401, 403]) {
    const result = await checkProviderCredential({
      descriptor: descriptor(),
      auth: apiAuth,
      fetchImpl: async () => new Response("nope", { status }),
    });
    assert.equal(result.status, "invalid_credential");
    assert.equal(result.httpStatus, status);
  }
});

test("404 means unverifiable, not rejected", async () => {
  const result = await checkProviderCredential({
    descriptor: descriptor(),
    auth: apiAuth,
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  assert.equal(result.status, "unsupported");
});

test("a 5xx or transport failure reports the provider as unreachable", async () => {
  const server = await checkProviderCredential({
    descriptor: descriptor(),
    auth: apiAuth,
    fetchImpl: async () => new Response("boom", { status: 503 }),
  });
  assert.equal(server.status, "unreachable");

  const offline = await checkProviderCredential({
    descriptor: descriptor(),
    auth: apiAuth,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(offline.status, "unreachable");
});

test("an error body that echoes the credential is redacted before it becomes a message", async () => {
  const result = await checkProviderCredential({
    descriptor: descriptor(),
    auth: apiAuth,
    fetchImpl: async () =>
      new Response("Invalid API key sk-fixture-secret supplied", { status: 401 }),
  });
  assert.equal(result.status, "invalid_credential");
  assert.ok(!result.message.includes("sk-fixture-secret"));
  assert.ok(result.message.includes("[redacted]"));
});

test("a hung provider aborts and reports unreachable rather than hanging the UI", async () => {
  const result = await checkProviderCredential({
    descriptor: descriptor(),
    auth: apiAuth,
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  assert.equal(result.status, "unreachable");
  assert.match(result.message, /did not respond/);
});
