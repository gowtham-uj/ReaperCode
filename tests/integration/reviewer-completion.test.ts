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

class StaticSequenceGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
      capabilities: {
        streaming: false,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
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
      role: "embedder",
      profileName: "embedder",
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

test("reviewer block verdict prevents completion and surfaces blocker", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Get a reviewer block, then try to complete. Completion should be rejected.",
  };

  const gateway = new StaticSequenceGateway([
    {
      assistant_message: "Calling reviewer subagent.",
      tool_calls: [
        {
          id: "review-call",
          name: "call_subagent",
          args: { type: "reviewer", task: "Review current plan", mode: "blocking" },
        },
      ],
    },
    {
      verdict: "block",
      evidence: "Missing test coverage for edge case.",
    },
    {
      assistant_message: "Trying to complete despite reviewer block.",
      tool_calls: [
        {
          id: "complete-call",
          name: "complete_task",
          args: { summary: "Done" },
        },
      ],
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  assert.equal(result.events.some((event) => event.message_type === "task_completed"), false);
});
