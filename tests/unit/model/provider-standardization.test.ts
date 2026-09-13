import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProvider,
  resolveProvider,
  resolveModelFromCatalog,
} from "../../../src/model/provider/registry.js";
import { findProviderDescriptor, PROVIDER_CATALOG } from "../../../src/model/provider/catalog.js";
import type { ProviderDescriptor } from "../../../src/model/provider/types.js";

const fixture: ProviderDescriptor = {
  id: "fixture-openai",
  label: "Fixture OpenAI",
  sdkFamily: "openai-chat",
  baseUrl: "https://example.invalid/v1",
  envVar: "FIXTURE_PROVIDER_KEY",
  envVars: ["FIXTURE_PROVIDER_KEY", "FIXTURE_PROVIDER_KEY_ALIAS"],
  keyHint: "test only",
  defaultModel: "fixture-model",
  models: ["fixture-model"],
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

test("supported-provider registry is populated from the OpenCode Models.dev catalog", () => {
  assert.ok(PROVIDER_CATALOG.length > 200);
  assert.equal(findProviderDescriptor("anthropic")?.npm, "@ai-sdk/anthropic");
  assert.equal(findProviderDescriptor("openai")?.npm, "@ai-sdk/openai");
  assert.ok((findProviderDescriptor("openrouter")?.models.length ?? 0) > 100);
});

test("registry builders reject unknown providers and resolve catalog models", () => {
  assert.throws(
    () => buildProvider({ providerId: "not-a-provider", role: "secondary_model" }),
    /unknown provider/,
  );
  const model = resolveModelFromCatalog({ providerId: "openai", role: "secondary_model" });
  assert.equal(model.providerId, "openai");
  assert.ok(model.modelId);
});

test("provider resolution accepts every declared environment alias", () => {
  const previousPrimary = process.env.FIXTURE_PROVIDER_KEY;
  const previousAlias = process.env.FIXTURE_PROVIDER_KEY_ALIAS;
  delete process.env.FIXTURE_PROVIDER_KEY;
  process.env.FIXTURE_PROVIDER_KEY_ALIAS = "fixture-secret";
  try {
    const resolved = resolveProvider(fixture);
    assert.equal(resolved.apiKey, "fixture-secret");
    assert.equal(resolved.descriptor.sdkFamily, "openai-chat");
    assert.equal(resolved.descriptor.baseUrl, "https://example.invalid/v1");
  } finally {
    if (previousPrimary === undefined) delete process.env.FIXTURE_PROVIDER_KEY;
    else process.env.FIXTURE_PROVIDER_KEY = previousPrimary;
    if (previousAlias === undefined) delete process.env.FIXTURE_PROVIDER_KEY_ALIAS;
    else process.env.FIXTURE_PROVIDER_KEY_ALIAS = previousAlias;
  }
});
