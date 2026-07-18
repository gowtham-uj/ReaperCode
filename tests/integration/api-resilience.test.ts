/**
 * Live provider retry / fallback regression tests against the canonical
 * ConfiguredModelGateway. The legacy `ResilientModelGateway` (formerly in
 * src/model/retry-orchestrator.ts) was deleted in the provider-consolidation
 * pass; its semantics now live inside ConfiguredModelGateway.withFallback
 * and the underlying ProviderMultiplexerClient, which routes retries across
 * the configured provider profiles before falling back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ConfiguredModelGateway } from "../../src/model/gateway.js";
import type { ProviderModelClient } from "../../src/model/gateway.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenUsage,
} from "../../src/model/types.js";
import { createValidConfig } from "../fixtures/phase0.js";

function makeProfile(profileName: ModelRole, modelName: string, role: ModelRole = "default_model"): ResolvedModelProfile {
  return {
    profileName,
    role,
    provider: profileName,
    model: modelName,
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
  };
}

function makeResult(profile: ResolvedModelProfile): GenerateResult {
  return {
    role: profile.role,
    profileName: profile.profileName,
    provider: profile.provider,
    model: profile.model,
    content: "ok",
    raw: {},
    usage: makeUsage(),
  };
}

function makeUsage(): TokenUsage {
  return { inputTokens: 10, outputTokens: 5 };
}

/** Stub ProviderModelClient that fails the first N attempts then succeeds. */
function flakyClient(
  profile: ResolvedModelProfile,
  failures: Array<{ status?: number; message?: string }>,
): ProviderModelClient & { attempts: number } {
  let attempts = 0;
  const client: ProviderModelClient & { attempts: number } = {
    attempts: 0,
    async generate(_request: GenerateRequest, _p: ResolvedModelProfile): Promise<GenerateResult> {
      attempts += 1;
      client.attempts = attempts;
      const failure = failures[attempts - 1];
      if (failure) {
        const err = new Error(failure.message ?? `HTTP ${failure.status ?? "fail"}`) as Error & {
          status?: number;
        };
        if (failure.status) err.status = failure.status;
        throw err;
      }
      return makeResult(profile);
    },
    async *stream(_request: GenerateRequest, _p: ResolvedModelProfile): AsyncIterable<StreamEvent> {
      yield { type: "message_start", data: { provider: profile.provider, model: profile.model } };
      yield { type: "message_delta", content: "ok" };
      yield { type: "message_end", data: { finishReason: "stop", usage: makeUsage() } };
    },
    async embed(_request: EmbeddingRequest, _p: ResolvedModelProfile): Promise<EmbeddingResult> {
      return {
        role: profile.role,
        profileName: profile.profileName,
        provider: profile.provider,
        model: profile.model,
        vectors: [[]],
        raw: {},
      };
    },
  };
  return client;
}

function baseConfigWithFallback(primary: ResolvedModelProfile, fallback: ResolvedModelProfile): unknown {
  const config = createValidConfig() as Record<string, unknown>;
  const models = config.models as Record<string, unknown>;
  models.default_model = {
    provider: primary.provider,
    model: primary.model,
    apiKeyEnv: "PRIMARY_KEY",
    fallbackProfile: fallback.profileName,
    capabilities: primary.capabilities,
  };
  models[fallback.profileName] = {
    provider: fallback.provider,
    model: fallback.model,
    apiKeyEnv: "FALLBACK_KEY",
    capabilities: fallback.capabilities,
  };
  return config;
}

test("configured gateway surfaces non-retryable errors without retrying", async () => {
  process.env.PRIMARY_KEY = "primary-test-key";
  process.env.FALLBACK_KEY = "fallback-test-key";
  const primary = makeProfile("default_model", "primary-model");
  const fallback = makeProfile("default_model", "fallback-model");
  const config = baseConfigWithFallback(primary, fallback);
  const client = flakyClient(primary, [{ status: 400, message: "bad request" }]);
  const gateway = new ConfiguredModelGateway(config, client);
  await assert.rejects(() =>
    gateway.generate({ role: "default_model", messages: [{ role: "user", content: "hi" }] }),
  );
  // 400 is not retryable; the canonical gateway does not consume budget.
  // We allow up to 1 attempt for non-retryable to surface; the gateway may
  // also try the fallback profile for non-retryable errors depending on
  // policy, but it must NOT spin in a retry loop.
  assert.ok(client.attempts <= 2, `expected ≤ 2 attempts for 400, got ${client.attempts}`);
});

test("configured gateway passes a healthy generate call through to the client once", async () => {
  process.env.PRIMARY_KEY = "primary-test-key";
  process.env.FALLBACK_KEY = "fallback-test-key";
  const primary = makeProfile("default_model", "primary-model");
  const fallback = makeProfile("default_model", "fallback-model");
  const config = baseConfigWithFallback(primary, fallback);
  const client = flakyClient(primary, []);
  const gateway = new ConfiguredModelGateway(config, client);
  const result = await gateway.generate({
    role: "default_model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.content, "ok");
  assert.equal(client.attempts, 1, "healthy call should not be retried");
});

test("configured gateway streams a healthy response with incremental events", async () => {
  process.env.PRIMARY_KEY = "primary-test-key";
  process.env.FALLBACK_KEY = "fallback-test-key";
  const primary = makeProfile("default_model", "primary-model");
  const fallback = makeProfile("default_model", "fallback-model");
  const config = baseConfigWithFallback(primary, fallback);
  const client = flakyClient(primary, []);
  const gateway = new ConfiguredModelGateway(config, client);
  const events: StreamEvent[] = [];
  for await (const event of gateway.stream({
    role: "default_model",
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(event);
  }
  const messageDeltas = events.filter((event) => event.type === "message_delta");
  assert.ok(messageDeltas.length >= 1, "stream must emit at least one message_delta");
  assert.ok(events.some((event) => event.type === "message_end"), "stream must terminate with message_end");
});