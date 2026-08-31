import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeTurnControl, type RuntimeEvent } from "../../src/runtime/events.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";

function createExecutor(
  workspaceRoot: string,
  overrides: Partial<ConstructorParameters<typeof ToolExecutor>[0]> = {},
): ToolExecutor {
  return new ToolExecutor({
    workspaceRoot,
    runId: "stream-run",
    sessionId: "stream-session",
    traceId: "stream-trace",
    logLevel: "info",
    safetyProfile: "allow_all",
    ...overrides,
  });
}

test("tool approval suspends execution and continues only after approval", async () => {
  const workspaceRoot = await createTempWorkspace();
  const events: RuntimeEvent[] = [];
  let requested = false;
  const executor = createExecutor(workspaceRoot, {
    permissionMode: "strict",
    eventSink: (event) => { events.push(event); },
    approvalRequester: {
      requestApproval: async () => {
        requested = true;
        await Promise.resolve();
        return "approved";
      },
    },
  });

  const result = await executor.execute({
    id: "approved-write",
    name: "write_file",
    args: { path: "approved.txt", content: "approved\n" },
  });

  assert.equal(requested, true);
  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(workspaceRoot, "approved.txt"), "utf8"), "approved\n");
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("approval.")).map((event) => event.type),
    ["approval.requested", "approval.resolved"],
  );
});

test("denied approval returns a tool error without touching disk", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = createExecutor(workspaceRoot, {
    permissionMode: "strict",
    approvalRequester: { requestApproval: async () => "denied" },
  });

  const result = await executor.execute({
    id: "denied-write",
    name: "write_file",
    args: { path: "denied.txt", content: "no\n" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "approval_required");
  await assert.rejects(access(path.join(workspaceRoot, "denied.txt")));
});

test("bash streams stdout and stderr chunks before completion", async () => {
  const workspaceRoot = await createTempWorkspace();
  const events: RuntimeEvent[] = [];
  const executor = createExecutor(workspaceRoot, {
    eventSink: (event) => { events.push(event); },
  });

  const result = await executor.execute({
    id: "shell-stream",
    name: "bash",
    args: { cmd: "printf alpha; printf beta >&2" },
  });

  assert.equal(result.ok, true);
  const deltas = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "command.output.delta" }> =>
      event.type === "command.output.delta",
  );
  assert.match(deltas.filter((event) => event.stream === "stdout").map((event) => event.text).join(""), /alpha/);
  assert.match(deltas.filter((event) => event.stream === "stderr").map((event) => event.text).join(""), /beta/);
  assert.ok(events.findIndex((event) => event.type === "command.output.delta") < events.findIndex((event) => event.type === "tool.completed"));
});

test("runtime emits live model deltas and drains steering before terminal stop", async () => {
  const workspaceRoot = await createTempWorkspace();
  const control = new RuntimeTurnControl();
  const gateway = new SteeringGateway(control);
  const events: RuntimeEvent[] = [];
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Start the task" };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
    turnControl: control,
    eventSink: (event) => { events.push(event); },
    writeHumanOutput: false,
  });

  const result = await engine.run();
  assert.equal(gateway.streamCalls, 2);
  assert.ok(gateway.requests[1]?.messages.some((message) => message.role === "user" && message.content === "Also mention steering"));
  assert.match(result.assistantMessage, /tests passed/i);
  assert.ok(events.some((event) => event.type === "assistant.reasoning.delta" && event.text === "checking"));
  assert.ok(events.some((event) => event.type === "assistant.message.delta"));
  assert.ok(events.some((event) => event.type === "assistant.message.completed"));
  assert.equal(events.at(0)?.type, "turn.started");
  assert.equal(events.at(-1)?.type, "turn.completed");
  assert.equal(control.steer("too late").accepted, false);
});

class SteeringGateway implements ModelGateway {
  streamCalls = 0;
  readonly requests: GenerateRequest[] = [];

  constructor(private readonly control: RuntimeTurnControl) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "streaming-test",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest) {
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "streaming-test",
      content: "Task complete. Tests passed.",
      finishReason: "stop",
      raw: {},
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.streamCalls += 1;
    this.requests.push(structuredClone(request));
    yield { type: "message_start", data: { provider: "test", model: "streaming-test" } };
    if (this.streamCalls === 1) {
      yield { type: "reasoning_delta", content: "checking" };
      yield { type: "message_delta", content: "Initial answer." };
      assert.equal(this.control.steer("Also mention steering").accepted, true);
    } else {
      yield { type: "message_delta", content: "Task complete. Tests passed." };
    }
    yield {
      type: "message_end",
      data: { finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: "default_model",
      profileName: "default_model",
      provider: "test",
      model: "streaming-test",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}
