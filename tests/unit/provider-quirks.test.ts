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

test("DeepSeek quirks request streaming usage and thinking default enabled", () => {
  assert.equal(shouldRequestStreamUsage({ provider: "deepseek", model: "deepseek-chat" }), true);
  assert.deepEqual(buildDeepSeekThinkingParam({ provider: "deepseek", model: "deepseek-v3" }), undefined);
  assert.deepEqual(buildDeepSeekThinkingParam({ provider: "deepseek", model: "deepseek-v4" }), { thinking: { type: "enabled" } });
  assert.deepEqual(
    buildDeepSeekThinkingParam({ provider: "deepseek", model: "deepseek-v4", defaultParams: { thinking: "disabled" } } as never),
    { thinking: { type: "disabled" } },
  );
});

test("provider max-token helper applies provider caps", () => {
  assert.equal(getEffectiveMaxOutputTokens({ ...baseProfile, defaultParams: { maxTokens: 20_000 } }, undefined), 16_384);
  assert.equal(getEffectiveMaxOutputTokens({ ...baseProfile, provider: "deepseek", model: "deepseek-chat", defaultParams: { maxTokens: 20_000 } }, undefined), 8192);
  assert.equal(getEffectiveMaxOutputTokens({ ...baseProfile, provider: "deepseek", model: "deepseek-chat" }, 20_000), 8192);
});

test("cerebras keeps no bespoke retry policy now that it is unsupported", () => {
  /*
   * This test used to assert Cerebras's extended rate-limit backoff (12 retries
   * at a 30s cap) and that its client was marked buffered. Both were real
   * behaviours of a provider this build no longer offers, so the assertions are
   * inverted rather than deleted: a provider that is supposedly gone must not
   * still be getting special treatment somewhere in the retry layer, which is
   * the kind of thing that survives a removal unnoticed.
   */
  const policy = getProviderRetryPolicy({ provider: "cerebras", maxRetries: undefined });
  const generic = getProviderRetryPolicy({ provider: "some-unknown-provider", maxRetries: undefined });
  assert.deepEqual(policy, generic, "cerebras must fall through to the default policy");

  // The generic policy still works for the statuses that matter, so this is a
  // removal of a special case and not of the retry logic itself.
  assert.equal(retryLimitForStatus(generic, 429), generic.maxRateLimitRetries);
  assert.equal(retryLimitForStatus(generic, 500), generic.maxRetries);
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
