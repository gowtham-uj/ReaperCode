import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

test("blocking call_subagent returns advisory result and main agent continues", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Ask a planner subagent for advice, then verify it did not mutate files.",
  };

  const gateway = new StaticSequenceGateway([
    {
      assistant_message: "Asking the planner for advisory guidance.",
      tool_calls: [
        {
          id: "ask-planner",
          name: "call_subagent",
          args: {
            type: "planner",
            task: "Plan how to verify subagent output remains advisory.",
            context: "Do not mutate files.",
            mode: "blocking",
            outputSchema: "plan",
          },
        },
      ],
    },
    {
      summary: "planner-result",
      recommendation: "Verify that subagent-mutation.txt does not exist.",
      tool_calls: [
        {
          id: "subagent-mutation",
          name: "write_file",
          args: { path: "subagent-mutation.txt", content: "should not be written\n" },
        },
      ],
    },
    {
      assistant_message: "Planner result was advisory; creating main-agent evidence and checking no subagent mutation occurred.",
      tool_calls: [
        {
          id: "verify-main-agent-continued",
          name: "bash",
          args: {
            cmd: "printf 'main-after-subagent\\n' > main-agent-after-subagent.txt && test \"$(cat main-agent-after-subagent.txt)\" = main-after-subagent && test ! -e subagent-mutation.txt",
            summary: "verify main agent continued and subagent did not write files",
            barrier: true,
          },
        },
      ],
    },
    {
      assistant_message: "The subagent result was advisory and no mutation file exists.",
      tool_calls: [
        {
          id: "complete-subagent-check",
          name: "complete_task",
          args: {
            summary: "Planner subagent returned advisory JSON, the main agent received another turn, and subagent-mutation.txt was not created.",
            verificationContract: {
              commands: [
                {
                  command: "test \"$(cat main-agent-after-subagent.txt)\" = main-after-subagent && test ! -e subagent-mutation.txt",
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

  const subagentResult = result.toolResults.find((item) => item.toolCallId === "ask-planner");
  assert.equal(subagentResult?.ok, true);
  assert.equal(subagentResult?.name, "call_subagent");
  assert.equal((subagentResult?.output as { advisory?: boolean } | undefined)?.advisory, true);
  assert.equal((subagentResult?.output as { result?: { summary?: string } } | undefined)?.result?.summary, "planner-result");

  const mainRequests = gateway.requests.filter((item) => item.source === "main_agent");
  assert.ok(mainRequests.length >= 3);
  assert.match(mainRequests[1]?.messages[0]?.content ?? "", /planner-result/);
  assert.match(mainRequests[1]?.messages[0]?.content ?? "", /"advisory": true/);

  assert.equal(gateway.requests.some((item) => item.source === "planner_subagent"), true);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "subagent-mutation"), false);
  assert.equal(await readFile(path.join(workspaceRoot, "main-agent-after-subagent.txt"), "utf8"), "main-after-subagent\n");
  await assert.rejects(access(path.join(workspaceRoot, "subagent-mutation.txt")));
  assert.equal(result.events.some((event) => event.message_type === "task_completed"), true);

  const trajectory = await readFile(result.trajectoryPath, "utf8");
  assert.match(trajectory, /"tool_name":"call_subagent"/);
});

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
