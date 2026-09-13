import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

/*
 * The transport-coverage gate added to the engine's provider preflight.
 *
 * The refusal itself — a catalog model naming an uninstalled package — is unit
 * tested against an injected catalog, because reproducing it here would mean
 * replacing the process-wide catalog singleton, and that singleton is captured
 * by `catalog.ts` at import time, before any test can set the environment
 * variable it reads. An engine test built on that would pass or fail according
 * to which test file the runner loaded first.
 *
 * What belongs here is the risk the gate introduces: it runs on *every* turn,
 * before *every* first provider call, and a gate that refuses working
 * configurations is worse than the failure it prevents. These two cases are
 * the ones most likely to be wrongly refused — a catalog provider, and a
 * provider the catalog has never heard of — and both must still reach the
 * provider.
 */

class RecordingGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];

  constructor(
    private readonly provider: string,
    private readonly model: string,
  ) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: this.provider,
      model: this.model,
      apiKey: "test-key-never-sent-anywhere",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw new Error("generate is not used by these runs");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "message_start", data: { provider: this.provider, model: this.model } };
    yield { type: "message_delta", content: "Reached the provider." };
    yield { type: "message_end", data: { finishReason: "stop" } };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
      provider: this.provider,
      model: this.model,
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}

async function runTurn(provider: string, model: string): Promise<RecordingGateway> {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Say hello." };
  const gateway = new RecordingGateway(provider, model);
  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();
  assert.equal(result.assistantMessage, "Reached the provider.");
  return gateway;
}

test("a catalog provider with an installed transport still reaches the provider", async () => {
  // `deepinfra` is a real Models.dev entry and `@ai-sdk/deepinfra` is
  // installed, so the coverage gate has to answer yes and let the turn through
  // untouched.
  const gateway = await runTurn("deepinfra", "zai-org/GLM-5.3-Flash");
  assert.ok(gateway.requests.length >= 1, "the run must still call the provider");
});

test("a provider outside the catalog is not refused for lacking a transport", async () => {
  /*
   * The legacy wire families — a direct Anthropic client, an explicit
   * OpenAI-compatible endpoint, a local LiteLLM — are not Models.dev entries.
   * Their routing belongs to the provider registry, which raises its own error
   * for anything it cannot resolve. Answering "unrunnable" for a provider the
   * catalog simply does not contain would break every configuration that
   * predates the catalog, which is most of what the integration suite runs.
   */
  const gateway = await runTurn("test", "static-json");
  assert.ok(gateway.requests.length >= 1, "the run must still call the provider");
});
