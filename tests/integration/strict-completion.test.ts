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

test("final-looking model text completes even when runtime evidence is missing", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create final-text.txt and verify it.",
    verification: { maxIterations: 1 },
  };
  const config = createValidConfig();
  config.verification.requireGroundedCompletion = true;
  const gateway = new StaticJsonGateway({
    assistant_message: "Task complete. final-text.txt has been saved and verified.",
    tool_calls: [],
  });

  const result = await new RuntimeEngine({
    config,
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
}).run();

  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.match(result.assistantMessage, /final-text\.txt has been saved/i);
});

class StaticJsonGateway implements ModelGateway {
  generateCount = 0;
  private readonly responses: unknown[];

  constructor(response: unknown | unknown[]) {
    this.responses = Array.isArray(response) ? response : [response];
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
      capabilities: {
        streaming: false,
        toolCalling: false,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.generateCount += 1;
    const response = this.responses[Math.min(this.generateCount - 1, this.responses.length - 1)];
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "static-json",
      content: JSON.stringify(response),
      finishReason: "stop",
      raw: response,
    };
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
      provider: "test",
      model: "static-json",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}
