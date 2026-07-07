import test from "node:test";
import assert from "node:assert/strict";

import { checkProviderProfileReadiness } from "../../src/model/preflight.js";
import type { ResolvedModelProfile } from "../../src/model/types.js";
import { ConfiguredModelGateway } from "../../src/model/gateway.js";

const profile: ResolvedModelProfile = {
  profileName: "secondary_model",
  role: "secondary_model",
  provider: "test-provider",
  model: "test-model",
  apiKeyEnv: "TEST_PROVIDER_KEY",
  apiBase: "https://provider.example/v1",
  capabilities: {
    streaming: true,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
  },
};

test("provider preflight catches missing credentials before a model call", () => {
  const result = checkProviderProfileReadiness(profile, {});
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /TEST_PROVIDER_KEY/);
});

test("provider preflight accepts a configured profile", () => {
  assert.equal(checkProviderProfileReadiness(profile, { TEST_PROVIDER_KEY: "configured" }).ok, true);
});

test("provider preflight failure routes generation to a configured fallback", async () => {
  const calls: string[] = [];
  const configuredProfile = {
    provider: profile.provider,
    model: profile.model,
    apiBase: profile.apiBase,
    apiKeyEnv: profile.apiKeyEnv,
    capabilities: profile.capabilities,
  };
  const gateway = new ConfiguredModelGateway(
    {
      models: {
        default_model: {
          ...configuredProfile,
          fallbackProfile: "fast_reasoner",
        },
        fast_reasoner: {
          ...configuredProfile,
          model: "fallback-model",
          apiKeyEnv: undefined,
        },
      },
    },
    {
      async generate(request, resolved) {
        calls.push(resolved.model);
        return {
          role: request.role,
          profileName: resolved.profileName,
          provider: resolved.provider,
          model: resolved.model,
          content: "ready",
          raw: {},
        };
      },
      async *stream() {
        yield { type: "message_end" as const };
      },
      async embed(request, resolved) {
        return {
          role: request.role,
          profileName: resolved.profileName,
          provider: resolved.provider,
          model: resolved.model,
          vectors: [],
          raw: {},
        };
      },
    },
  );

  const result = await gateway.generate({ role: "default_model", messages: [{ role: "user", content: "test" }] });
  assert.equal(result.model, "fallback-model");
  assert.deepEqual(calls, ["fallback-model"]);
});
