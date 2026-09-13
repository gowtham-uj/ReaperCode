import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { AiSdkProviderClient } from "../../../src/model/providers/ai-sdk-client.js";
import { fromToolCalls, fromUsage, toModelMessages, toToolSet } from "../../../src/model/providers/ai-sdk-mapper.js";
import type { GenerateRequest, ResolvedModelProfile } from "../../../src/model/types.js";

interface Captured {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/**
 * Minimal OpenAI-compatible endpoint. Returns the caller-supplied SSE frames
 * verbatim so tests assert on Reaper's normalization, not on a vendor.
 */
async function withServer(
  respond: (captured: Captured) => { status?: number; sse?: string[]; json?: unknown },
  run: (baseUrl: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const record: Captured = {
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
      };
      captured.push(record);
      const result = respond(record);
      if (result.sse) {
        response.writeHead(result.status ?? 200, { "content-type": "text/event-stream" });
        for (const frame of result.sse) response.write(`data: ${frame}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(result.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}/v1`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function profile(apiBase: string): ResolvedModelProfile {
  return {
    provider: "fixture-openai-compatible",
    model: "fixture-model",
    apiBase,
    apiKey: "per-call-secret",
    profileName: "default_model",
    role: "default_model",
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
    },
  };
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    role: "default_model",
    system: "You are Reaper.",
    messages: [{ role: "user", content: "list the files" }],
    ...overrides,
  };
}

test("generate sends per-call credentials and returns normalized content and usage", async () => {
  await withServer(
    () => ({
      json: {
        id: "cmpl-1",
        object: "chat.completion",
        model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content: "two files" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      },
    }),
    async (baseUrl, captured) => {
      const client = new AiSdkProviderClient();
      const result = await client.generate(request(), profile(baseUrl));
      assert.equal(result.content, "two files");
      assert.equal(result.finishReason, "stop");
      assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 3 });
      assert.equal(captured[0]?.authorization, "Bearer per-call-secret");
      assert.equal(captured[0]?.path, "/v1/chat/completions");
      const messages = captured[0]?.body.messages as Array<{ role: string }>;
      assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
    },
  );
});

test("stream normalizes deltas, tool calls, and the terminating usage frame", async () => {
  await withServer(
    () => ({
      sse: [
        JSON.stringify({ choices: [{ index: 0, delta: { content: "check" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { content: "ing" } }] }),
        JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "file_view", arguments: "{\"path\":\"a.ts\"}" },
              }],
            },
          }],
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
      ],
    }),
    async (baseUrl, captured) => {
      const client = new AiSdkProviderClient();
      const events: Array<{ type: string; content?: string; data?: unknown }> = [];
      for await (const event of client.stream(
        request({ tools: [{ name: "file_view", description: "view", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] }),
        profile(baseUrl),
      )) {
        events.push(event);
      }

      assert.equal(events[0]?.type, "message_start");
      const text = events.filter((e) => e.type === "message_delta").map((e) => e.content).join("");
      assert.equal(text, "checking");

      const toolCall = events.find((e) => e.type === "tool_call");
      assert.deepEqual(toolCall?.data, { id: "call_1", name: "file_view", args: { path: "a.ts" } });

      const end = events.at(-1);
      assert.equal(end?.type, "message_end");
      assert.deepEqual(end?.data, {
        finishReason: "tool-calls",
        usage: { inputTokens: 42, outputTokens: 7 },
      });

      // Tools reach the wire in OpenAI function form and the SDK does not
      // execute them — the agent loop does.
      const tools = captured[0]?.body.tools as Array<{ type: string; function: { name: string } }>;
      assert.equal(tools[0]?.type, "function");
      assert.equal(tools[0]?.function.name, "file_view");
    },
  );
});

test("an aborted stream stops the request", async () => {
  await withServer(
    () => ({ sse: [JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })] }),
    async (baseUrl) => {
      const controller = new AbortController();
      const client = new AiSdkProviderClient();
      controller.abort();
      await assert.rejects(async () => {
        for await (const _ of client.stream(request({ abortSignal: controller.signal }), profile(baseUrl))) {
          // drain
        }
      });
    },
  );
});

test("provider errors surface as thrown errors, not silent completions", async () => {
  await withServer(
    () => ({ status: 401, json: { error: { message: "invalid api key" } } }),
    async (baseUrl) => {
      const client = new AiSdkProviderClient();
      await assert.rejects(
        () => client.generate(request(), { ...profile(baseUrl), maxRetries: 0 }),
        /invalid api key|401/i,
      );
    },
  );
});

test("assistant tool calls and tool results round-trip through the message mapper", () => {
  const messages = toModelMessages({
    role: "default_model",
    messages: [
      { role: "user", content: "read a.ts" },
      {
        role: "assistant",
        content: "",
        reasoning: "I should read the file",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "file_view", arguments: "{\"path\":\"a.ts\"}" } }],
      },
      { role: "tool", content: "file contents", tool_call_id: "call_1" },
    ],
  });

  assert.equal(messages.length, 3);
  const assistant = messages[1] as { role: string; content: Array<Record<string, unknown>> };
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content.map((part) => part.type), ["reasoning", "tool-call"]);
  assert.deepEqual(assistant.content[1]?.input, { path: "a.ts" });

  const toolMessage = messages[2] as { role: string; content: Array<Record<string, unknown>> };
  assert.equal(toolMessage.role, "tool");
  // The tool name is recovered from the call it answers, which providers that
  // validate call/result pairing require.
  assert.equal(toolMessage.content[0]?.toolName, "file_view");
  assert.deepEqual(toolMessage.content[0]?.output, { type: "text", value: "file contents" });
});

test("tool errors are marked so the model sees a failure, not a result", () => {
  const messages = toModelMessages({
    role: "default_model",
    messages: [{ role: "tool", content: "ENOENT", tool_call_id: "call_9", name: "file_view", is_error: true }],
  });
  const toolMessage = messages[0] as { content: Array<Record<string, unknown>> };
  assert.deepEqual(toolMessage.content[0]?.output, { type: "error-text", value: "ENOENT" });
});

test("both Reaper and OpenAI tool shapes convert to a tool set", () => {
  const set = toToolSet([
    { name: "reaper_shape", description: "d", inputSchema: { type: "object", properties: {} } },
    { type: "function", function: { name: "openai_shape", description: "d", parameters: { type: "object", properties: {} } } },
    { nonsense: true },
  ]);
  assert.deepEqual(Object.keys(set ?? {}).sort(), ["openai_shape", "reaper_shape"]);
  assert.equal(toToolSet([]), undefined);
});

test("tool calls convert back to the OpenAI objects the executor consumes", () => {
  assert.deepEqual(
    fromToolCalls([{ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }]),
    [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }],
  );
});

test("usage normalization keeps cache fields only when the provider reports them", () => {
  assert.deepEqual(fromUsage({ inputTokens: 5, outputTokens: 2 }), { inputTokens: 5, outputTokens: 2 });
  assert.deepEqual(
    fromUsage({ inputTokens: 5, outputTokens: 2, cachedInputTokens: 4 }),
    { inputTokens: 5, outputTokens: 2, cacheReadTokens: 4 },
  );
  assert.equal(fromUsage(undefined), undefined);
  assert.equal(fromUsage({}), undefined);
});
