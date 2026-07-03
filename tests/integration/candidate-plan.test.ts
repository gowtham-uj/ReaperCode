import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

test("candidate plan marker is created via bash and run finishes with natural stop", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create .candidate-plan-marker via bash and finish after verifying it.",
  };
  const gateway = new StreamingJsonGateway([
    {
      assistant_message: "Creating and verifying the candidate plan marker.",
      tool_calls: [
        {
          id: "create-marker",
          name: "bash",
          args: {
            cmd: "printf 'candidate-plan-ok\\n' > .candidate-plan-marker && test \"$(cat .candidate-plan-marker)\" = candidate-plan-ok",
            summary: "create and verify candidate plan marker",
            timeout: 60,
          },
        },
      ],
    },
    {
      assistant_message:
        "Done: the candidate-plan marker was created and verified successfully; the shell check confirms the file contains candidate-plan-ok.",
      tool_calls: [],
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  // Natural stop: the model emitted empty tool_calls + a final assistant_message.
  assert.ok(result.assistantMessage.length > 0);
  assert.match(result.assistantMessage, /candidate-plan marker was created and verified successfully/);

  // The bash tool call executed and succeeded.
  const bashResult = result.toolResults.find((item) => item.toolCallId === "create-marker");
  assert.equal(bashResult?.name, "bash");
  assert.equal(bashResult?.ok, true);

  // The run did not use a complete_task tool call (no such tool in the
  // model-facing surface); the model stopped on its own with empty tool_calls.
  assert.equal(
    result.toolResults.some((item) => item.name === "complete_task"),
    false,
  );

  // The marker file exists with the expected content.
  assert.equal(
    await readFile(path.join(workspaceRoot, ".candidate-plan-marker"), "utf8"),
    "candidate-plan-ok\n",
  );
});

test("strategic runtime routing does not use currentStepIndex", async () => {
  const source = await readFile(path.join(process.cwd(), "src/runtime/engine.ts"), "utf8");
  const routingRegion = source.slice(
    source.indexOf("const routeAfterBootstrap"),
    source.indexOf("type RuntimeNodeName"),
  );

  assert.doesNotMatch(routingRegion, /currentStepIndex/);
  assert.doesNotMatch(source, /new StateGraph|@langchain\/langgraph/);
});

interface StaticResponse {
  assistant_message?: string;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

class StreamingJsonGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];
  private readonly responses: StaticResponse[];
  private callIndex = 0;

  constructor(responses: StaticResponse[]) {
    this.responses = responses;
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
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
    throw new Error("generate not used; StreamingJsonGateway only supports stream()");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? { assistant_message: "", tool_calls: [] };
    this.callIndex += 1;
    yield { type: "message_start", data: { provider: "test", model: "static-json" } };
    if (response.assistant_message) {
      yield { type: "message_delta", content: response.assistant_message };
    }
    for (const call of response.tool_calls ?? []) {
      yield {
        type: "tool_call",
        data: {
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        },
      };
    }
    yield { type: "message_end", data: { finishReason: "stop" } };
  }

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
