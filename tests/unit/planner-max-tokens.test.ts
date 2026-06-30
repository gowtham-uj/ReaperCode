import test from "node:test";
import assert from "node:assert/strict";

import { resolvePlannerMaxTokensForProfile } from "../../src/runtime/engine.js";
import type { ModelRole, ResolvedModelProfile } from "../../src/model/types.js";

test("planner maxTokens scales with provider profile", async () => {
  assert.equal(await resolvePlannerMaxTokensForProfile(makeGateway("minimax", "MiniMax-M3")), 16384);
  assert.equal(await resolvePlannerMaxTokensForProfile(makeGateway("deepinfra", "Qwen/Qwen2.5-7B-Instruct")), 8192);
  assert.equal(await resolvePlannerMaxTokensForProfile(makeGateway("anthropic", "claude-opus-4-8")), 8192);
  assert.equal(await resolvePlannerMaxTokensForProfile(makeGateway("openrouter", "openai/gpt-4o-mini")), 8192);
  // unknown provider falls back to default (6144)
  assert.equal(await resolvePlannerMaxTokensForProfile(makeGateway("weird-provider", "foo-1")), 6144);
});

function makeGateway(provider: string, model: string): { modelGateway: { resolveRole: (role: ModelRole) => Promise<ResolvedModelProfile> } } {
  return {
    modelGateway: {
      resolveRole: async (): Promise<ResolvedModelProfile> => ({
        role: "planner",
        profileName: "planner",
        provider,
        model,
        capabilities: {
          streaming: false,
          toolCalling: false,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
        },
      }),
    },
  };
}
