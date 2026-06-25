import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLiteLLMStream } from "../../src/model/providers/stream-normalizer.js";
import { classifyToolCall, isReadOnlyShellCommand } from "../../src/execution/planner.js";
import { parseMainAgentToolCallsDetailed, buildToolCallParseErrorsFeedback } from "../../src/runtime/main-agent-node.js";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("normalizeLiteLLMStream yields a tool_call event when tool_calls finish_reason arrives", async () => {
  const response = sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ]);
  const events: Array<{ type: string; data?: { name?: string; arguments?: string } }> = [];
  for await (const ev of normalizeLiteLLMStream(response)) {
    events.push(ev as { type: string; data?: { name?: string; arguments?: string } });
  }
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.data?.name, "read_file");
  assert.equal(toolCalls[0]?.data?.arguments, '{"path":"a.ts"}');
  assert.equal(events.at(-1)?.type, "message_end");
});

test("isReadOnlyShellCommand recognizes safe observation commands", () => {
  assert.equal(isReadOnlyShellCommand("ls -la"), true);
  assert.equal(isReadOnlyShellCommand("cat package.json"), true);
  assert.equal(isReadOnlyShellCommand("git status"), true);
  assert.equal(isReadOnlyShellCommand("git log --oneline -5"), true);
  assert.equal(isReadOnlyShellCommand("grep -R 'TODO' src"), true);
  assert.equal(isReadOnlyShellCommand("find . -name '*.ts'"), true);
  // Chained or mutating commands are NOT read-only.
  assert.equal(isReadOnlyShellCommand("ls && rm -rf /"), false);
  assert.equal(isReadOnlyShellCommand("cat foo > bar"), false);
  assert.equal(isReadOnlyShellCommand("npm test"), false);
  assert.equal(isReadOnlyShellCommand("python -c 'import os; os.system(\"rm -rf /\")'"), false);
});

test("classifyToolCall defaults unknown shell commands to barrier", () => {
  assert.equal(
    classifyToolCall({ name: "run_shell_command", args: { cmd: "python script.py" } } as any),
    "shell_barrier",
  );
  // Explicit read-only opt-in still works.
  assert.equal(
    classifyToolCall({ name: "run_shell_command", args: { cmd: "ls -la", forceNonBarrier: true } } as any),
    "shell_non_barrier",
  );
  // Read-only allowlist is honored.
  assert.equal(
    classifyToolCall({ name: "run_shell_command", args: { cmd: "ls -la" } } as any),
    "shell_non_barrier",
  );
});

test("parseMainAgentToolCallsDetailed separates valid calls from parse errors", () => {
  const response = {
    content: "",
    toolCalls: [
      { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      { id: "2", type: "function", function: { name: "definitely_not_a_tool", arguments: "{}" } },
      { id: "3", type: "function", function: { name: "read_file", arguments: '{"oops":' } },
    ],
  };
  const { calls, parseErrors } = parseMainAgentToolCallsDetailed(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read_file");
  // Two parse errors: unknown tool name and bad args.
  assert.equal(parseErrors.length, 2);
  const feedback = buildToolCallParseErrorsFeedback(parseErrors);
  assert.equal(feedback.length, 3); // header + 2 errors
  const [header] = feedback;
  assert.ok(header);
  assert.match(header, /malformed/);
});
