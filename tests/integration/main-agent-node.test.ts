import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import {
  buildMainAgentBehaviorFeedback,
  callMainAgent,
  parseMainAgentToolCalls,
} from "../../src/runtime/main-agent-node.js";
import { buildMainAgentSystemPrompt } from "../../src/runtime/main-agent-prompt.js";
import { validateToolCallBatch } from "../../src/runtime/tool-validation.js";
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

test("parses main-agent tool calls from JSON content and provider toolCalls", () => {
  const fromContent = parseMainAgentToolCalls(makeGenerateResult({
    assistant_message: "",
    tool_calls: [{ name: "read_file", arguments: { path: "src/app.ts" } }],
  }));
  assert.equal(fromContent[0]?.name, "read_file");
  assert.match(fromContent[0]?.id ?? "", /^main-agent-/);

  const fromProvider = parseMainAgentToolCalls({
    ...makeGenerateResult({ assistant_message: "", tool_calls: [] }),
    toolCalls: [{ id: "grep-1", name: "grep_search", args: { pattern: "Reaper" } }],
  });
  assert.deepEqual(fromProvider, [{ id: "grep-1", name: "grep_search", args: { pattern: "Reaper" } }]);
});

test("calls model gateway with main-agent role route and source metadata", async () => {
  const config = createValidConfig();
  const gateway = new StaticGateway({ assistant_message: "", tool_calls: [{ id: "ls-1", name: "list_directory", args: { path: "." } }] });

  const result = await callMainAgent({
    modelGateway: gateway,
    role: config.modelRouting.mainAgent,
    system: "system",
    cockpit: "cockpit",
  });

  assert.equal(gateway.requests[0]?.role, "main_reasoner");
  assert.equal(gateway.requests[0]?.source, "main_agent");
  assert.equal(gateway.requests[0]?.messages[0]?.content, "cockpit");
  assert.equal(result.source, "main_agent");
  assert.equal(result.feedback.length, 0);
  assert.equal(result.toolCalls[0]?.name, "list_directory");
});

test("non-empty no-tool assistant response is accepted as terminal summary", async () => {
  const gateway = new StaticGateway({ assistant_message: "Done: the task is complete and tests pass.", tool_calls: [] });
  const result = await callMainAgent({
    modelGateway: gateway,
    system: "system",
    cockpit: "cockpit",
  });

  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.validationBlockers.length, 0);
  assert.equal(result.feedback.length, 0);
});

test("empty main-agent response gets behavior feedback", async () => {
  const gateway = new StaticGateway({ assistant_message: "", tool_calls: [] });
  const result = await callMainAgent({
    modelGateway: gateway,
    system: "system",
    cockpit: "cockpit",
  });

  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.validationBlockers[0]?.code, "empty_tool_call_batch");
  assert.match(result.feedback.join("\n"), /did not include tool calls or a final assistant summary/i);
  assert.match(buildMainAgentBehaviorFeedback(result.validationBlockers).join("\n"), /final assistant_message/i);
});

test("main-agent system prompt allows Codex-style final summary without forced tools", () => {
  const prompt = buildMainAgentSystemPrompt({});
  assert.match(prompt, /Codex-style terminal behavior/);
  assert.match(prompt, /final assistant_message and no tool_calls/);
  assert.doesNotMatch(prompt, /Do not complete without complete_task/);
});

test("truncated main-agent response is rejected before tool parsing", async () => {
  const gateway = new StaticGateway(
    { assistant_message: "", tool_calls: [{ id: "unsafe-partial", name: "list_directory", args: { path: "." } }] },
    "length",
  );
  const result = await callMainAgent({
    modelGateway: gateway,
    system: "system",
    cockpit: "cockpit",
  });

  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.validationBlockers[0]?.code, "empty_tool_call_batch");
  assert.match(result.feedback.join("\n"), /reached maxTokens/i);
});

test("main-agent tool calls validate and flow into runtime execution", async () => {
  const workspaceRoot = await createTempWorkspace();
  const gateway = new StaticGateway({
    assistant_message: "",
    tool_calls: [
      { id: "read-app", name: "read_file", args: { path: "src/app.ts" } },
      { id: "replace-app", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "43" } },
    ],
  });
  const mainAgent = await callMainAgent({
    modelGateway: gateway,
    role: createValidConfig().modelRouting.mainAgent,
    system: "system",
    cockpit: "cockpit",
  });

  assert.equal(validateToolCallBatch(mainAgent.toolCalls).ok, true);

  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Apply main-agent tool calls",
    tool_calls: mainAgent.toolCalls,
  };

  const result = await new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  }).run();

  const app = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(app, /43/);
  assert.equal(result.toolResults.some((item) => item.toolCallId === "replace-app" && item.ok), true);
});

function makeGenerateResult(raw: unknown): GenerateResult {
  return {
    role: "main_reasoner",
    profileName: "main_reasoner",
    provider: "test",
    model: "static-json",
    content: JSON.stringify(raw),
    finishReason: "stop",
    raw,
  };
}

class StaticGateway implements ModelGateway {
  readonly requests: GenerateRequest[] = [];

  constructor(
    private readonly response: unknown,
    private readonly finishReason: NonNullable<GenerateResult["finishReason"]> = "stop",
  ) {}

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
    return {
      ...makeGenerateResult(this.response),
      finishReason: this.finishReason,
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
