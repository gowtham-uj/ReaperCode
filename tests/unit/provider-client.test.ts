import test from "node:test";
import assert from "node:assert/strict";

import { ProviderMultiplexerClient } from "../../src/model/providers/provider-client.js";
import type { ProviderModelClient } from "../../src/model/gateway.js";
import type { EmbeddingRequest, GenerateRequest, ResolvedModelProfile, StreamEvent } from "../../src/model/types.js";

class RecordingClient implements ProviderModelClient {
  public calls = 0;

  constructor(private readonly provider: string) {}

  async generate(request: GenerateRequest, profile: ResolvedModelProfile) {
    this.calls += 1;
    return {
      role: request.role,
      profileName: profile.profileName,
      provider: this.provider,
      model: profile.model,
      content: this.provider,
      raw: {},
    };
  }

  async *stream(_request: GenerateRequest, _profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {}

  async embed(_request: EmbeddingRequest, _profile: ResolvedModelProfile): Promise<any> {
    throw new Error("not implemented");
  }
}

const baseProfile: ResolvedModelProfile = {
  role: "secondary_model",
  profileName: "default_model",
  provider: "deepseek",
  model: "model",
  capabilities: {
    streaming: true,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
  },
};

test("provider multiplexer dispatches official DeepSeek to DeepSeek client", async () => {
  const deepseek = new RecordingClient("deepseek");
  const openAiCompatible = new RecordingClient("openai-compatible");
  const client = new ProviderMultiplexerClient({ deepseek: deepseek as any, openAiCompatible: openAiCompatible as any });

  const result = await client.generate({ role: "secondary_model", messages: [] }, baseProfile);

  assert.equal(result.provider, "deepseek");
  assert.equal(deepseek.calls, 1);
  assert.equal(openAiCompatible.calls, 0);
});

test("cerebras is not offered, even though the catalog lists it", async () => {
  /*
   * The removal, pinned rather than trusted.
   *
   * `cerebras` is one of 213 providers in the vendored models.dev snapshot, and
   * any catalog provider no legacy client claims is bound to the generic AI SDK
   * transport. Deleting the dedicated client therefore was not enough on its
   * own: the provider would have kept working through the fallback, silently,
   * with the AI SDK client answering in its place. This test fails if the
   * catalog exclusion is ever dropped — which is exactly how the removal would
   * come back.
   */
  const openAiCompatible = new RecordingClient("openai-compatible");
  const client = new ProviderMultiplexerClient({ openAiCompatible: openAiCompatible as any });

  await assert.rejects(
    // Wrapped in an async thunk: `resolveProviderClient` refuses synchronously,
    // so the bare call would throw before `assert.rejects` could observe it.
    async () => await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider: "cerebras" }),
    (error: unknown) => {
      assert.ok(error instanceof Error, "expected a resolution error");
      /*
       * Asserting the provider is named, not the exact message.
       *
       * Two independent mechanisms refuse this and either may speak first: the
       * registry entry that supplied its base URL is gone, and the catalog
       * exclusion stops it being bound to the generic AI SDK family. Measured,
       * the base-URL check throws first with "Provider \"cerebras\" has no API
       * base URL". Pinning that sentence would make this test fail if the
       * mechanisms were reordered, which is not a behaviour change worth
       * failing over. What matters is that it is refused and the error says
       * which provider.
       */
      assert.match(error.message, /cerebras/i);
      return true;
    },
  );
  assert.equal(openAiCompatible.calls, 0, "the generic transport must not pick it up");
});

test("provider multiplexer dispatches OpenAI-compatible providers to generic client", async () => {
  const openAiCompatible = new RecordingClient("openai-compatible");
  const client = new ProviderMultiplexerClient({ openAiCompatible: openAiCompatible as any });

  for (const provider of ["openai", "openrouter", "azure"] as const) {
    const result = await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider });
    assert.equal(result.provider, "openai-compatible");
  }

  assert.equal(openAiCompatible.calls, 3);
});

test("provider multiplexer dispatches Anthropic to official Anthropic client", async () => {
  const anthropic = new RecordingClient("anthropic");
  const openAiCompatible = new RecordingClient("openai-compatible");
  const client = new ProviderMultiplexerClient({ anthropic: anthropic as any, openAiCompatible: openAiCompatible as any });

  const result = await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider: "anthropic" });

  assert.equal(result.provider, "anthropic");
  assert.equal(anthropic.calls, 1);
  assert.equal(openAiCompatible.calls, 0);
});

test("provider multiplexer routes catalog providers through the AI SDK client", async () => {
  const aiSdk = new RecordingClient("ai-sdk");
  const openAiCompatible = new RecordingClient("openai-compatible");
  const client = new ProviderMultiplexerClient({ aiSdk: aiSdk as any, openAiCompatible: openAiCompatible as any });

  for (const provider of ["groq", "mistral", "google", "amazon-bedrock"] as const) {
    const result = await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider });
    assert.equal(result.provider, "ai-sdk", `${provider} did not route through the AI SDK client`);
  }

  assert.equal(aiSdk.calls, 4);
  assert.equal(openAiCompatible.calls, 0);
});

test("legacy provider bindings still win over the catalog-wide AI SDK binding", async () => {
  const aiSdk = new RecordingClient("ai-sdk");
  const anthropic = new RecordingClient("anthropic");
  const deepseek = new RecordingClient("deepseek");
  const client = new ProviderMultiplexerClient({
    aiSdk: aiSdk as any,
    anthropic: anthropic as any,
    deepseek: deepseek as any,
  });

  await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider: "anthropic" });
  await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider: "deepseek" });

  assert.equal(anthropic.calls, 1);
  assert.equal(deepseek.calls, 1);
  assert.equal(aiSdk.calls, 0);
});
