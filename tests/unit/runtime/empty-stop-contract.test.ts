import test from "node:test";
import assert from "node:assert/strict";

import { streamMainAgentResponseWithTransportRetry } from "../../../src/runtime/engine.js";

// This test covers (2) Empty-stop re-prompt. We can't directly
// test the live loop's branching without booting the full runtime,
// so we verify the contract of streamMainAgentResponseWithTransportRetry:
// when the model-gateway has no transport errors and the assistant
// turn is empty, the helper must NOT pretend to be the model by
// returning a fake assistant text. The runtime's natural-stop path
// (in engine.ts) is the place that injects the re-prompt; this test
// simply ensures the helper doesn't get in the way.

test("transport-retry helper: returns the model's actual empty turn without injecting synthetic text", async () => {
  let calls = 0;
  // Mock gateway: returns an empty assistant turn.
  const gw = {
    generate: async () => {
      calls += 1;
      return {
        content: "",
        finishReason: "stop",
        toolCalls: [],
        role: "assistant",
        provider: "test",
        model: "test",
        raw: {},
      };
    },
    stream: (_req: any) => {
      return {
        async *[Symbol.asyncIterator]() {
          calls += 1;
          yield { type: "message_start", data: { provider: "test", model: "test" } };
          // No message_delta — the model returned an empty turn.
          yield {
            type: "message_end",
            data: {
              finishReason: "stop",
              usage: { promptTokens: 0, completionTokens: 0, inputTokens: 0, outputTokens: 0 },
            },
          };
        },
      };
    },
  } as any;
  const turn = await streamMainAgentResponseWithTransportRetry(gw, {} as any, {
    write: async () => undefined,
  } as any);
  // The helper returned the model's actual turn (empty content).
  // It did NOT inject a synthetic "transport fallback" message
  // because the model call succeeded; the empty content is the
  // model's own natural-stop signal.
  // Note: when the model returns no tool calls, the streaming
  // parser does not set `toolCalls` at all, so we accept either
  // undefined or [] here.
  assert.ok(!turn.toolCalls || (turn.toolCalls as unknown[]).length === 0);
  assert.equal(turn.content, "");
  assert.equal(calls, 1);
});
