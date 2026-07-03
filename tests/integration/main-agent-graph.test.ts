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

test("main-agent graph completes after shell evidence and natural stop", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create .reaper-main-agent-marker and finish after verifying it.",
  };
  const gateway = new StreamingJsonGateway([
    {
      assistant_message: "Creating and checking the marker.",
      tool_calls: [
        {
          id: "create-marker",
          name: "bash",
          args: {
            cmd: "printf 'main-agent-graph-ok\\n' > .reaper-main-agent-marker && test \"$(cat .reaper-main-agent-marker)\" = main-agent-graph-ok",
            summary: "create and verify the main-agent graph marker",
            timeout: 60,
          },
        },
      ],
    },
    {
      assistant_message:
        "Marker .reaper-main-agent-marker contains main-agent-graph-ok and was verified by the main-agent graph.",
      tool_calls: [],
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  const mainAgentRequests = gateway.requests.filter((item) => item.source === "main_agent");
  assert.ok(mainAgentRequests.length >= 1);
  assert.equal(mainAgentRequests.every((item) => item.role === "main_reasoner"), true);

  // Natural stop: the model's final assistant_message (empty tool_calls) IS
  // the run's final summary. No complete_task tool call was made.
  assert.equal(
    result.assistantMessage,
    "Marker .reaper-main-agent-marker contains main-agent-graph-ok and was verified by the main-agent graph.",
  );
  // The bash tool call executed and succeeded.
  const bashResult = result.toolResults.find((item) => item.toolCallId === "create-marker");
  assert.equal(bashResult?.name, "bash");
  assert.equal(bashResult?.ok, true);
  assert.equal(
    result.toolResults.some((item) => item.name === "complete_task"),
    false,
  );
  assert.equal(
    await readFile(path.join(workspaceRoot, ".reaper-main-agent-marker"), "utf8"),
    "main-agent-graph-ok\n",
  );

  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.match(trajectory, /"to_step":"Inspect Project"/);
  assert.match(trajectory, /"to_step":"Extract Task Contract"/);
  assert.match(trajectory, /"to_step":"Content Prep"/);
  assert.match(trajectory, /"to_step":"Main Agent"/);
  assert.doesNotMatch(trajectory, /"source":"(?:simple_executor|complex_orchestrator|plan_autonomous|dispatch_step|step_executor_subagent|repair_autonomous|patcher_subagent|completion_gate)"/);
});

test("main-agent graph finishes with empty-tool final summary (natural stop)", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create .reaper-synth-marker, verify it, and finish.",
  };
  const gateway = new StreamingJsonGateway([
    {
      assistant_message: "Creating and checking the synth marker.",
      tool_calls: [
        {
          id: "create-synth-marker",
          name: "bash",
          args: {
            cmd: "printf 'synth-ok\\n' > .reaper-synth-marker && test \"$(cat .reaper-synth-marker)\" = synth-ok",
            summary: "create and verify synth marker",
            timeout: 60,
          },
        },
      ],
    },
    {
      assistant_message:
        "Done: the synth marker was created and verified successfully; the passing shell check confirms the requested task is complete.",
      tool_calls: [],
    },
  ]);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  // The model's final assistant_message (emitted with empty tool_calls) is
  // the run's final summary. No complete_task tool call, no verification gate.
  assert.ok(result.assistantMessage.length > 0);
  assert.match(result.assistantMessage, /synth marker was created and verified successfully/);
  assert.equal(
    result.toolResults.some((item) => item.name === "complete_task"),
    false,
  );
  assert.equal(
    await readFile(path.join(workspaceRoot, ".reaper-synth-marker"), "utf8"),
    "synth-ok\n",
  );
});

test("main-agent transport retry exhaustion reports infra failure without completion-gate attempts", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Trigger provider 429 handling.",
  };
  const gateway = new ThrowingGateway(429);

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  }).run();

  // The transport retry loop (backoffsMs = [0, 1_000, 3_000, 9_000]) attempts
  // every backoff slot. The gateway records one request per attempt.
  assert.equal(gateway.requests.length, 4);
  // summarizeNode always emits task_completed (even on infra failure), so we
  // check the assistant message and trajectory instead.
  assert.match(result.assistantMessage, /transport error|infrastructure\/provider|rate_limit transport/i);
  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.match(trajectory, /rate_limit/);
  assert.doesNotMatch(trajectory, /gate_exhausted/);
});

class ThrowingGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];

  constructor(private readonly status: number) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "throwing",
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
    throw this.makeError();
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    throw this.makeError();
  }

  private makeError(): Error {
    const error = new Error(
      `LiteLLM generate request failed with status ${this.status} provider=minimax model=MiniMax-M3 body={"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached","http_code":"${this.status}"}}`,
    ) as Error & { status?: number };
    error.status = this.status;
    return error;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "embedder",
      profileName: "embedder",
      provider: "test",
      model: "throwing",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}

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
