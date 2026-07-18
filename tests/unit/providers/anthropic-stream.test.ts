/**
 * Mocked Anthropic SSE streaming tests.
 *
 * Verifies the parser extracts:
 *   - text deltas → message_delta events before the final message_end
 *   - tool_use input_json_delta → final tool_call event on content_block_stop
 *   - usage (input + output + cache_read + cache_creation) on message_end
 *   - finish_reason (stop_reason) on message_end
 *   - abort signal mid-stream → throws AbortError
 *   - malformed / error events surface readable errors
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseAnthropicSseStream } from "../../../src/model/providers/anthropic.js";
import type { StreamEvent } from "../../../src/model/types.js";

function encodeSse(events: Array<{ event?: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = events
    .map((event) => {
      const lines: string[] = [];
      if (event.event) lines.push(`event: ${event.event}`);
      const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      lines.push(`data: ${data}`);
      return lines.join("\n") + "\n\n";
    })
    .join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

test("SSE parser emits text deltas in order before the final message_end", async () => {
  const stream = encodeSse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-test-1",
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const events = await collect(parseAnthropicSseStream(stream, undefined));
  const textDeltas = events
    .filter((event) => event.type === "message_delta" && typeof event.content === "string")
    .map((event) => event.content);
  assert.deepEqual(textDeltas, ["Hello ", "world"]);
  const tail = events.at(-1);
  assert.ok(tail && tail.type === "message_end");
  assert.equal((tail.data as { finishReason?: string }).finishReason, "end_turn");
});

test("SSE parser reconstructs tool_use from fragmented input_json_delta", async () => {
  const stream = encodeSse([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_2", model: "claude-test-2", usage: { input_tokens: 5 } } } },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_abc", name: "bash" } },
    },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"cmd\":" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"echo hi\"}" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const events = await collect(parseAnthropicSseStream(stream, undefined));
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.ok(toolCall, "tool_call event must be emitted");
  const data = toolCall!.data as { id: string; name: string; arguments: string };
  assert.equal(data.id, "toolu_abc");
  assert.equal(data.name, "bash");
  const parsed = JSON.parse(data.arguments);
  assert.deepEqual(parsed, { cmd: "echo hi" });
  const tail = events.at(-1);
  assert.equal((tail!.data as { finishReason?: string }).finishReason, "tool_use");
});

test("SSE parser forwards cache_read and cache_creation token counts", async () => {
  const stream = encodeSse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_3",
          model: "claude-test-3",
          usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 7 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "stop" }, usage: { output_tokens: 3 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const events = await collect(parseAnthropicSseStream(stream, undefined));
  const tail = events.at(-1)!;
  const usage = (tail.data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }).usage!;
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 3);
  assert.equal(usage.cacheReadTokens, 7);
  assert.equal(usage.cacheWriteTokens, 20);
});

test("SSE parser throws on Anthropic 'error' event", async () => {
  const stream = encodeSse([
    { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "service overloaded" } } },
  ]);
  await assert.rejects(() => collect(parseAnthropicSseStream(stream, undefined)), /overloaded/);
});

test("SSE parser aborts cleanly when the supplied abort signal fires mid-stream", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("event: ping\n\n"));
      // Yield a tiny delay so the reader can pick up the first chunk,
      // then the test's controller will abort.
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.enqueue(encoder.encode("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}\n\n"));
      controller.close();
    },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(
    () => collect(parseAnthropicSseStream(stream, controller.signal)),
    (err: unknown) => err instanceof Error && /abort/i.test(err.message),
  );
});