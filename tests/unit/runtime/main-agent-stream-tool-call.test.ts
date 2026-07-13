import assert from "node:assert/strict";
import test from "node:test";

import { streamMainAgentResponse } from "../../../src/runtime/main-agent-node.js";

test("streamMainAgentResponse preserves bash timeout from single-shot tool_call events", async () => {
  const gateway = {
    async *stream() {
      yield {
        type: "tool_call",
        data: {
          id: "call_bash_timeout",
          name: "bash",
          arguments: JSON.stringify({
            cmd: "echo ok",
            description: "verify bash timeout is preserved",
            timeout: 5,
          }),
        },
        content: JSON.stringify({
          cmd: "echo ok",
          description: "verify bash timeout is preserved",
          timeout: 5,
        }),
      };
      yield { type: "message_end", data: { finishReason: "tool_calls" } };
    },
  };

  const turn = await streamMainAgentResponse(gateway as any, {
    role: "secondary_model",
    source: "main_agent",
    system: "",
    messages: [],
    tools: [],
  } as any);

  assert.equal(turn.finishReason, "tool_calls");
  assert.deepEqual(turn.toolCalls, [
    {
      id: "call_bash_timeout",
      name: "bash",
      args: {
        cmd: "echo ok",
        description: "verify bash timeout is preserved",
        timeout: 5,
      },
    },
  ]);
});

test("streamMainAgentResponse drops unknown legacy tool names with a parse error", async () => {
  const gateway = {
    async *stream() {
      yield {
        type: "tool_call",
        data: {
          id: "call_complete",
          name: "complete_task",
          arguments: JSON.stringify({ summary: "verified work complete" }),
        },
      };
      yield { type: "message_end", data: { finishReason: "tool_calls" } };
    },
  };

  const turn = await streamMainAgentResponse(gateway as any, {
    role: "secondary_model",
    source: "main_agent",
    system: "",
    messages: [],
    tools: [],
  } as any);

  // complete_task is no longer a registered tool: the call must not become
  // an executable tool call, and the model gets a structured parse error.
  assert.equal(turn.toolCalls, undefined);
  const dropped = (turn.raw as { droppedToolCalls?: Array<{ name?: string }> }).droppedToolCalls ?? [];
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.name, "complete_task");
});
