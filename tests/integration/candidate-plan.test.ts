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

test("candidate plan stays advisory until main agent accepts it", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Use advisory plan memory, then create .candidate-plan-marker and finish after verifying it.",
  };
  const gateway = new StaticJsonGateway([
    {
      assistant_message: "Recording candidate plan and TODO memory.",
      tool_calls: [
        {
          id: "candidate-plan",
          name: "update_plan",
          args: {
            markdown: "## Candidate Plan\n- This is not accepted yet.",
            candidate: true,
          },
        },
        {
          id: "todo-memory",
          name: "update_todo",
          args: {
            items: [{ id: "marker", content: "Create and verify candidate plan marker", done: false }],
          },
        },
      ],
    },
    {
      assistant_message: "Accepting the plan before acting on it.",
      tool_calls: [
        {
          id: "accept-plan",
          name: "update_plan",
          args: {
            markdown: "## Accepted Plan\n- Create marker with shell evidence.",
          },
        },
      ],
    },
    {
      assistant_message: "Creating and verifying the marker.",
      tool_calls: [
        {
          id: "create-marker",
          name: "run_shell_command",
          args: {
            cmd: "printf 'candidate-plan-ok\\n' > .candidate-plan-marker && test \"$(cat .candidate-plan-marker)\" = candidate-plan-ok",
            summary: "create and verify candidate plan marker",
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
            summary: "Marker .candidate-plan-marker contains candidate-plan-ok and was verified after accepting advisory plan memory.",
            verificationContract: {
              commands: [
                {
                  command: "test \"$(cat .candidate-plan-marker)\" = candidate-plan-ok",
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
  assert.ok(mainAgentRequests.length >= 4);
  assert.match(String(mainAgentRequests[1]?.messages[0]?.content), /Active Plan\nNone\./);
  assert.match(String(mainAgentRequests[1]?.messages[0]?.content), /Candidate 1:\n## Candidate Plan/);
  assert.match(String(mainAgentRequests[1]?.messages[0]?.content), /- \[ \] marker: Create and verify candidate plan marker/);
  assert.match(String(mainAgentRequests[2]?.messages[0]?.content), /Active Plan\n## Accepted Plan/);
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);
  assert.equal(await readFile(path.join(workspaceRoot, ".candidate-plan-marker"), "utf8"), "candidate-plan-ok\n");
});

test("strategic graph routing does not use currentStepIndex", async () => {
  const source = await readFile(path.join(process.cwd(), "src/runtime/engine.ts"), "utf8");
  const routingRegion = source.slice(
    source.indexOf("const routeAfterBootstrap"),
    source.indexOf("const graph = new StateGraph"),
  );

  assert.doesNotMatch(routingRegion, /currentStepIndex/);
});

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
