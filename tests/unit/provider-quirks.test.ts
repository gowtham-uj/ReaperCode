import test from "node:test";
import assert from "node:assert/strict";

import {
  anthropicAuthHeaderForProvider,
  buildDeepSeekThinkingParam,
  getDefaultStructuredModePreference,
  getEffectiveMaxOutputTokens,
  getProviderRetryPolicy,
  isMiniMaxM3,
  isRetryableProviderStatus,
  parseRetryAfterMs,
  prefersBufferedJsonGenerate,
  providerBackoffMs,
  retryLimitForStatus,
  shouldRequestStreamUsage,
  shouldUseBufferedProviderGenerate,
} from "../../src/model/provider-quirks.js";
import type { ResolvedModelProfile } from "../../src/model/types.js";

const baseProfile: ResolvedModelProfile = {
  provider: "openai",
  model: "gpt-4.1",
  role: "default_model",
  profileName: "default_model",
  timeoutMs: 30_000,
  capabilities: {
    streaming: true,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
    maxOutputTokens: 16_384,
  },
};

test("MiniMax M3 prefers buffered provider JSON structured output", () => {
  assert.equal(isMiniMaxM3({ provider: "minimax", model: "MiniMax-M3" }), true);
  assert.equal(isMiniMaxM3({ provider: "minimax-oauth", model: "MiniMax-M3" }), true);
  assert.equal(isMiniMaxM3({ provider: "openai", model: "MiniMax-M3" }), true);
  assert.equal(prefersBufferedJsonGenerate({ provider: "minimax-oauth", model: "MiniMax-M3" }, { responseFormat: "json" }), true);
  assert.equal(prefersBufferedJsonGenerate({ provider: "minimax-oauth", model: "MiniMax-M3" }, {}), false);
  assert.equal(getDefaultStructuredModePreference({ provider: "minimax", model: "MiniMax-M3" }), "provider_json");
});

test("DeepSeek quirks request streaming usage and optional v4 thinking", () => {
  assert.equal(shouldRequestStreamUsage({ provider: "deepseek", model: "deepseek-chat" }), true);
  assert.deepEqual(buildDeepSeekThinkingParam({ provider: "deepseek", model: "deepseek-v3" }), undefined);
  assert.deepEqual(buildDeepSeekThinkingParam({ provider: "deepseek", model: "deepseek-v4" }), { thinking: { type: "disabled" } });
});

test("provider max-token helper applies provider caps", () => {
  assert.equal(getEffectiveMaxOutputTokens({ ...baseProfile, defaultParams: { maxTokens: 20_000 } }, undefined), 16_384);
  assert.equal(getEffectiveMaxOutputTokens({ ...baseProfile, provider: "deepseek", model: "deepseek-chat", defaultParams: { maxTokens: 20_000 } }, undefined), 8192);
  assert.equal(getEffectiveMaxOutputTokens({ ...baseProfile, provider: "deepseek", model: "deepseek-chat" }, 20_000), 8192);
});

test("Cerebras direct client is marked as buffered and has extended rate-limit retries", () => {
  assert.equal(shouldUseBufferedProviderGenerate({ provider: "cerebras", model: "qwen-3-coder" }, {}), true);
  const policy = getProviderRetryPolicy({ provider: "cerebras", maxRetries: undefined });
  assert.equal(policy.maxRetries, 2);
  assert.ok(policy.maxRateLimitRetries >= 12);
  assert.equal(retryLimitForStatus(policy, 429), policy.maxRateLimitRetries);
  assert.equal(retryLimitForStatus(policy, 500), policy.maxRetries);
});

test("Anthropic-compatible provider quirks pick the correct API-key header", () => {
  assert.equal(anthropicAuthHeaderForProvider({ provider: "anthropic", model: "claude-opus-4-8" }), "x-api-key");
  assert.equal(anthropicAuthHeaderForProvider({ provider: "minimax-oauth", model: "MiniMax-M3" }), "X-Api-Key");
});

test("provider retry helpers normalize retry statuses and Retry-After", () => {
  assert.equal(isRetryableProviderStatus(408), true);
  assert.equal(isRetryableProviderStatus(429), true);
  assert.equal(isRetryableProviderStatus(503), true);
  assert.equal(isRetryableProviderStatus(400), false);
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(providerBackoffMs({ attempt: 0, status: 429, jitterMs: 0, durationMs: 0 }), 2000);
  assert.equal(providerBackoffMs({ attempt: 0, status: 500, jitterMs: 0, durationMs: 0 }), 500);
});
