/**
 * Main agent should use the provider streaming path for tool-enabled turns:
 * accumulate streamed tool-call deltas, wait for message_end, then return the
 * completed tool batch for normal validation/execution. This mirrors the
 * reference-agent behavior and prevents partial tool execution.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { callMainAgent, parseMainAgentToolCalls, streamMainAgentResponse } from "../../../src/runtime/main-agent-node.js";
import type { GenerateRequest, ModelGateway, ModelRole, StreamEvent } from "../../../src/model/types.js";
import { normalizeToolCall } from "../../../src/tools/normalize.js";
import { ToolCallSchema, type ToolCall } from "../../../src/tools/types.js";

class FakeStreamingGateway implements ModelGateway {
  readonly calls: GenerateRequest[] = [];
  async resolveRole(role: ModelRole) {
    return {
      profileName: role,
      role,
      provider: "fake",
      model: "fake-model",
      capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
    };
  }
  async generate(): Promise<never> {
    throw new Error("generate should not be used for tool-enabled main-agent turns");
  }
  async embed(): Promise<never> {
    throw new Error("embed not used");
  }
  async countTokens(): Promise<number> {
    return 0;
  }
  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.calls.push(request);
    yield { type: "message_start", data: { provider: "fake", model: "fake-model" } };
    yield { type: "message_delta", content: "" };
    yield {
      type: "tool_call",
      data: {
        id: "call_1",
        name: "write_file",
        args: { path: "package.json", content: "{}" },
      },
    };
    yield { type: "message_end", data: { finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 5 } } };
  }
}

test("streamMainAgentResponse accumulates streamed tool calls into GenerateResult", async () => {
  const gateway = new FakeStreamingGateway();
  const result = await streamMainAgentResponse(gateway, {
    role: "secondary_model",
    source: "main_agent",
    messages: [{ role: "user", content: "build" }],
    tools: [{ name: "write_file" }],
  });
  assert.equal(result.provider, "fake");
  assert.equal(result.model, "fake-model");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "write_file", args: { path: "package.json", content: "{}" } }]);
});

test("callMainAgent uses stream instead of generate when tools are present", async () => {
  const gateway = new FakeStreamingGateway();
  const result = await callMainAgent({
    modelGateway: gateway,
    system: "Return JSON",
    cockpit: "Build a repo",
    tools: [{ name: "write_file" }],
  });
  assert.equal(gateway.calls.length, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "write_file");
  assert.deepEqual(result.toolCalls[0]?.args, { path: "package.json", content: "{}" });
});

test("parseMainAgentToolCalls accepts reference-style read/write/edit tool names", () => {
  const calls = parseMainAgentToolCalls({
    toolCalls: [
      { id: "1", name: "read", args: { path: "package.json" } },
      { id: "2", name: "write", args: { path: "src/index.ts", content: "export {};" } },
      { id: "3", name: "edit", args: { path: "src/index.ts", oldString: "export {};", newString: "export const ok = true;" } },
    ],
  });

  assert.deepEqual(calls.map((call) => call.name), ["read_file", "write_file", "replace_in_file"]);
  assert.deepEqual(calls[1]?.args, { path: "src/index.ts", content: "export {};" });
});

class FakeStreamingToolDeltaGateway implements ModelGateway {
  readonly fires: string[] = [];
  async resolveRole(role: ModelRole) {
    return {
      profileName: role, role, provider: "fake", model: "fake-model",
      capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
    };
  }
  async generate(): Promise<never> { throw new Error("generate should not be used"); }
  async embed(): Promise<never> { throw new Error("embed not used"); }
  async countTokens(): Promise<number> { return 0; }
  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
    yield { type: "message_start", data: { provider: "fake", model: "fake-model" } };
    // Multi-delta tool call: each call ships in pieces, then a complete one follows.
    yield { type: "tool_call", data: { id: "call_a", name: "write", function: { arguments: "{\"path\":\"a.ts\"," } } };
    yield { type: "tool_call", data: { id: "call_a", function: { arguments: "\"content\":\"hi\"}" } } };
    yield { type: "tool_call", data: { id: "call_b", name: "write", function: { arguments: "{\"path\":\"b.ts\",\"content\":\"bye\"}" } } };
    yield { type: "message_end", data: { finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1 } } };
  }
}

test("streamMainAgentResponse returns completed tool calls without dispatching them", async () => {
  const gateway = new FakeStreamingToolDeltaGateway();
  const result = await streamMainAgentResponse(gateway, {
    role: "secondary_model",
    source: "main_agent",
    messages: [{ role: "user", content: "build" }],
    tools: [{ name: "write" }],
  });

  // Match the reference loop: streaming only assembles the assistant message.
  // The engine pushes the assistant message first, then executes returned
  // toolCalls sequentially and appends matching tool results. No Reaper-only
  // callback fires tool results before the assistant message exists.
  assert.deepEqual(
    (result.toolCalls ?? []).map((c) => (c as ToolCall).name),
    ["write_file", "write_file"],
  );
  assert.deepEqual((result.toolCalls?.[0] as ToolCall | undefined)?.args, {
    path: "a.ts",
    content: "hi",
  });
  assert.deepEqual((result.toolCalls?.[1] as ToolCall | undefined)?.args, {
    path: "b.ts",
    content: "bye",
  });
});

// Adapter sanity check for normalize (independent of streaming). Already
// covered in tools/normalize tests; included here to fail fast when the
// alias is dropped.
test("normalizeToolCall maps reference-style name to canonical name", () => {
  const normalized = normalizeToolCall({
    id: "1",
    name: "write",
    args: { path: "x", content: "y" },
  });
  assert.equal(ToolCallSchema.safeParse(normalized).success, true);
  const parsed = ToolCallSchema.safeParse(normalized);
  if (parsed.success) {
    assert.equal(parsed.data.name, "write_file");
  }
});
