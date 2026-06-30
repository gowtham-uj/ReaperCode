/**
 * Streaming OpenAI-compatible tool calls arrive as deltas. Reaper must
 * accumulate them into complete tool calls and only expose the final call
 * once the upstream response is complete, so the runtime executes a complete
 * batch rather than partial/malformed args.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLiteLLMStream } from "../../../src/model/providers/stream-normalizer.js";

function responseFromSse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }));
}

test("OpenAI stream tool-call deltas assemble into one complete tool_call before message_end", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\\"path\\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"package.json\\\",\\\"content\\\":\\\"{}\\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const events = [];
  for await (const event of normalizeLiteLLMStream(responseFromSse(chunks))) {
    events.push(event);
  }

  // Pi-style: tool_call is emitted exactly once, at finish_reason — never
  // mid-stream. The buffer flush in `message_end` is a no-op because
  // `emitted` is set to true mid-stream (we just defer the actual emit).
  const toolCallEvents = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCallEvents.length, 1, "tool_call emitted exactly once, at finish_reason");
  assert.equal(toolCallEvents[0]?.type, "tool_call");
  assert.equal((toolCallEvents[0] as { data?: { finishReason?: string } }).data?.finishReason, undefined);
  const lastToolCall =
    (events.findLast((e) => e.type === "tool_call") as (typeof events)[number] | undefined) ??
    (toolCallEvents[0] as (typeof events)[number] | undefined);
  if (!lastToolCall) throw new Error("expected a tool_call event");
  assert.equal((lastToolCall as { data?: { name?: string } }).data?.name, "write_file");
  assert.equal(
    (lastToolCall as { data?: { arguments?: string } }).data?.arguments,
    '{"path":"package.json","content":"{}"}',
  );
  const last = events[events.length - 1];
  if (!last) throw new Error("expected at least one event");
  assert.equal(last.type, "message_end");
  assert.deepEqual((last as { data?: { finishReason?: string } }).data, { finishReason: "tool_calls" });
});
