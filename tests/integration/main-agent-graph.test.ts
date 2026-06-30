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

test("main-agent graph completes after shell evidence and explicit completion", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create .reaper-main-agent-marker and finish after verifying it.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Creating and checking the marker.",
      tool_calls: [
        {
          id: "create-marker",
          name: "bash",
          args: {
            cmd: "printf 'main-agent-graph-ok\\n' > .reaper-main-agent-marker && test \"$(cat .reaper-main-agent-marker)\" = main-agent-graph-ok",
            summary: "create and verify the main-agent graph marker",
          },
        },
      ],
    },
    {
      assistant_message: "Marker exists and was verified.",
      tool_calls: [
        {
          id: "complete-marker",
          name: "complete_task",
          args: {
            summary: "Marker .reaper-main-agent-marker contains main-agent-graph-ok and was verified by the main-agent graph.",
            verificationContract: {
              commands: [
                {
                  command: "test \"$(cat .reaper-main-agent-marker)\" = main-agent-graph-ok",
                  required: true,
                },
              ],
            },
          },
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

  const mainAgentRequests = gateway.requests.filter((item) => item.source === "main_agent");
  assert.ok(mainAgentRequests.length >= 1);
  assert.equal(mainAgentRequests.every((item) => item.role === "main_reasoner"), true);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.verification?.ok, true);
  assert.equal(result.assistantMessage, "Marker .reaper-main-agent-marker contains main-agent-graph-ok and was verified by the main-agent graph.");
  assert.equal(await readFile(path.join(workspaceRoot, ".reaper-main-agent-marker"), "utf8"), "main-agent-graph-ok\n");

  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.match(trajectory, /"to_step":"Inspect Project"/);
  assert.match(trajectory, /"to_step":"Extract Task Contract"/);
  assert.match(trajectory, /"to_step":"Content Prep"/);
  assert.match(trajectory, /"to_step":"Main Agent"/);
  assert.doesNotMatch(trajectory, /"source":"(?:simple_executor|complex_orchestrator|plan_autonomous|dispatch_step|step_executor_subagent|repair_autonomous|patcher_subagent|completion_gate)"/);
});

test("main-agent graph synthesizes complete_task from empty-tool final summary", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Create .reaper-synth-marker, verify it, and finish.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Creating and checking the synth marker.",
      tool_calls: [
        {
          id: "create-synth-marker",
          name: "bash",
          args: {
            cmd: "printf 'synth-ok\\n' > .reaper-synth-marker && test \"$(cat .reaper-synth-marker)\" = synth-ok",
            summary: "create and verify synth marker",
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

  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(result.verification?.ok, true);
  assert.match(result.assistantMessage, /synth marker was created and verified successfully/);
  assert.equal(await readFile(path.join(workspaceRoot, ".reaper-synth-marker"), "utf8"), "synth-ok\n");
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

  assert.equal(gateway.requests.length, 3);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), false);
  assert.match(result.assistantMessage, /transport retry budget exhausted|infrastructure\/provider failure/i);
  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.match(trajectory, /"stop_reason":"infra_failed"/);
  assert.match(trajectory, /"completion_gate_attempts":0/);
  assert.doesNotMatch(trajectory, /"stop_reason":"gate_exhausted"/);
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
    const error = new Error(
      `LiteLLM generate request failed with status ${this.status} provider=minimax model=MiniMax-M3 body={"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached","http_code":"${this.status}"}}`,
    ) as Error & { status?: number };
    error.status = this.status;
    throw error;
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

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

class StaticJsonGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];
  private readonly responses: unknown[];

  constructor(response: unknown[]) {
    this.responses = response;
  }

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
