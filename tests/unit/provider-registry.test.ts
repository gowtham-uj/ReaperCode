import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveProviderBaseUrl,
  resolveProviderDefaults,
  resolveProviderModelName,
} from "../../src/model/providers/provider-registry.js";
import { getDefaultDeepSeekModel } from "../fixtures/live-models.js";

const baseProfile = {
  profileName: "default_model" as const,
  role: "secondary_model" as const,
  provider: "deepseek",
  model: getDefaultDeepSeekModel(),
  capabilities: {
    streaming: true,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
  },
};

test("resolves official DeepSeek default base URL", () => {
  assert.equal(resolveProviderBaseUrl(baseProfile), "https://api.deepseek.com");
});

test("resolves ZAI default base URL", () => {
  const profile = {
    ...baseProfile,
    provider: "zai",
    model: "glm-5",
  };

  assert.equal(resolveProviderBaseUrl(profile), "https://api.z.ai/api/paas/v4");
  assert.equal(resolveProviderModelName(profile), "glm-5");
});

test("resolves Azure OpenAI as deployment-style provider", () => {
  const profile = {
    ...baseProfile,
    provider: "azure",
    model: "prod-gpt",
    apiBase: "https://example.openai.azure.com",
  };

  const defaults = resolveProviderDefaults(profile);
  assert.equal(resolveProviderBaseUrl(profile), "https://example.openai.azure.com");
  assert.equal(resolveProviderModelName(profile), "prod-gpt");
  assert.equal(defaults.authHeader, "api-key");
  assert.equal(defaults.pathStyle, "azure-openai");
});

test("uses explicit apiBase for unknown providers", () => {
  const profile = {
    ...baseProfile,
    provider: "custom-provider",
    apiBase: "https://custom.example/v1",
  };

  assert.equal(resolveProviderBaseUrl(profile), "https://custom.example/v1");
});

test("resolves official Anthropic default base URL", () => {
  const profile = {
    ...baseProfile,
    provider: "anthropic",
    model: "claude-sonnet-4",
  };

  assert.equal(resolveProviderBaseUrl(profile), "https://api.anthropic.com/v1");
  assert.equal(resolveProviderModelName(profile), "claude-sonnet-4");
  assert.equal(resolveProviderDefaults(profile).pathStyle, "openai");
});

test("maps DeepInfra-style Qwen ID to CrazyRouter Qwen slug", () => {
  const profile = {
    ...baseProfile,
    provider: "crazyrouter",
    model: "Qwen/Qwen3.6-35B-A3B",
  };

  assert.equal(resolveProviderBaseUrl(profile), "https://crazyrouter.com/v1");
  assert.equal(resolveProviderModelName(profile), "qwen3.6-plus");
});

test("routes unknown providers through LiteLLM by default", () => {
  const profile = {
    ...baseProfile,
    provider: "custom-litellm-provider",
    model: "example-model",
  };

  assert.equal(resolveProviderBaseUrl(profile), "http://127.0.0.1:4000");
  assert.equal(resolveProviderModelName(profile), "custom-litellm-provider/example-model");
  assert.equal(resolveProviderDefaults(profile).pathStyle, "openai");
});
