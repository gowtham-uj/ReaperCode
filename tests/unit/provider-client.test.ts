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

test("provider multiplexer dispatches Cerebras to Cerebras client", async () => {
  const cerebras = new RecordingClient("cerebras");
  const openAiCompatible = new RecordingClient("openai-compatible");
  const client = new ProviderMultiplexerClient({ cerebras: cerebras as any, openAiCompatible: openAiCompatible as any });

  const result = await client.generate({ role: "secondary_model", messages: [] }, { ...baseProfile, provider: "cerebras" });

  assert.equal(result.provider, "cerebras");
  assert.equal(cerebras.calls, 1);
  assert.equal(openAiCompatible.calls, 0);
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
