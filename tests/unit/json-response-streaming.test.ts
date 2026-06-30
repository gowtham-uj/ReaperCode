/**
 * json-response-streaming.test.ts — proves that `streamStructuredJson`
 * emits Pi-style per-chunk deltas via both the onDelta sink and the
 * Hooks bus (so the TUI sees text appear as the model produces it),
 * buffers the full content, and parses the structured JSON at the
 * end identically to the non-streaming path.
 *
 * Three cases:
 *   1. Provider yields multiple message_delta chunks → buffered +
 *      parsed correctly; deltas emitted in order.
 *   2. Provider yields a reasoning_delta + a message_delta → both
 *      deltas surface to onDelta with the right `kind`.
 *   3. Provider stream() throws → falls back to non-streaming
 *      generateStructuredJsonInQueue path and still returns a parsed
 *      result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Hooks } from "../../src/adaptive/hooks.js";
import { streamStructuredJson } from "../../src/model/json-response.js";
import type { EmbeddingRequest, EmbeddingResult, GenerateRequest, GenerateResult, ModelGateway, ResolvedModelProfile, StreamEvent, TokenCountRequest } from "../../src/model/types.js";

interface FakeGatewayOptions {
  chunks: StreamEvent[];
  /** Override the response returned by `generate()` for the fallback path. */
  fallbackResponse?: GenerateResult;
  throwOnStream?: boolean;
}

function makeFakeGateway(opts: FakeGatewayOptions) {
  const calls = { generateCount: 0, streamCount: 0 };
  const gateway: ModelGateway = {
    async resolveRole(): Promise<ResolvedModelProfile> {
      return {
        provider: "fake",
        model: "fake-model",
        profileName: "default_model",
        role: "default_model",
        capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
        timeoutMs: 30_000,
      };
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      calls.generateCount += 1;
      if (opts.throwOnStream) {
        // Even when stream throws, generate must return a parseable result
        // so the fallback path can succeed. We always return a structured
        // envelope for the test fixture.
        return (
          opts.fallbackResponse ?? {
            content: JSON.stringify({ assistant_message: "fallback reply", tool_calls: [] }),
            provider: "fake",
            model: "fake-model",
            profileName: "default_model",
            role: request.role,
            finishReason: "stop",
            raw: {},
          }
        );
      }
      return opts.fallbackResponse ?? {
        content: "",
        provider: "fake",
        model: "fake-model",
        profileName: "default_model",
        role: request.role,
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
      calls.streamCount += 1;
      if (opts.throwOnStream) {
        throw new Error("stream transport failed");
      }
      for (const ev of opts.chunks) yield ev;
      // Suppress unused-param lint
      void request;
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return {
        role: request.role,
        profileName: request.role,
        provider: "fake",
        model: "fake-model",
        vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
        raw: {},
      };
    },
    async countTokens(_request: TokenCountRequest): Promise<number> {
      return 0;
    },
  };
  return { gateway, calls };
}

test("streamStructuredJson: buffers per-chunk deltas and parses the full envelope", async () => {
  const fullJson = JSON.stringify({
    assistant_message: "Hello there!",
    tool_calls: [],
  });
  // Split the JSON into word-sized chunks to simulate token streaming.
  const words = fullJson.match(/\S+\s*/g) ?? [fullJson];
  const chunks: StreamEvent[] = [
    { type: "message_start", data: { provider: "fake", model: "fake-model" } },
    ...words.map<StreamEvent>((w) => ({ type: "message_delta", content: w })),
    { type: "message_end", data: { finishReason: "stop" } },
  ];
  const { gateway, calls } = makeFakeGateway({ chunks });
  const deltas: string[] = [];
  const result = await streamStructuredJson<{ assistant_message: string; tool_calls: unknown[] }>({
    modelGateway: gateway,
    role: "default_model",
    messages: [{ role: "user", content: "hi" }],
    parse: (value) => value as { assistant_message: string; tool_calls: unknown[] },
    onDelta: (delta) => {
      if (delta.kind === "message") deltas.push(delta.text);
    },
  });
  assert.equal(calls.streamCount, 1, "must call stream() once");
  assert.equal(calls.generateCount, 0, "must NOT fall back to generate() when streaming succeeds");
  assert.equal(result.assistant_message, "Hello there!", "must parse the buffered envelope");
  assert.deepEqual(result.tool_calls, []);
  assert.equal(deltas.join(""), fullJson, "every chunk must surface to onDelta in order");
});

test("streamStructuredJson: emits reasoning + message deltas with the right kind", async () => {
  const fullJson = JSON.stringify({ assistant_message: "ok", tool_calls: [] });
  const chunks: StreamEvent[] = [
    { type: "message_start", data: {} },
    { type: "reasoning_delta", content: "thinking " },
    { type: "reasoning_delta", content: "hard about this" },
    { type: "message_delta", content: fullJson },
    { type: "message_end", data: { finishReason: "stop" } },
  ];
  const { gateway } = makeFakeGateway({ chunks });
  const kinds: string[] = [];
  const texts: string[] = [];
  await streamStructuredJson({
    modelGateway: gateway,
    role: "default_model",
    messages: [{ role: "user", content: "x" }],
    parse: (value) => value,
    onDelta: (delta) => {
      kinds.push(delta.kind);
      if (delta.kind === "reasoning" || delta.kind === "message") texts.push(delta.text);
    },
  });
  assert.deepEqual(kinds, ["reasoning", "reasoning", "message"]);
  assert.equal(texts[0], "thinking ");
  assert.equal(texts[1], "hard about this");
  assert.equal(texts[2], fullJson);
});

test("streamStructuredJson: also fans out deltas via the Hooks bus (TUI contract)", async () => {
  const fullJson = JSON.stringify({ assistant_message: "streamed", tool_calls: [] });
  const chunks: StreamEvent[] = [
    { type: "message_start", data: {} },
    { type: "message_delta", content: fullJson },
    { type: "message_end", data: { finishReason: "stop" } },
  ];
  const { gateway } = makeFakeGateway({ chunks });
  const hooks = new Hooks({ securityFailClosed: false });
  const assistantDeltas: string[] = [];
  const assistantComplete: string[] = [];
  hooks.on("AssistantMessageDelta", (evt) => {
    const p = evt.payload as { text?: string };
    if (typeof p.text === "string") assistantDeltas.push(p.text);
    return { allow: true };
  });
  hooks.on("AssistantMessageComplete", (evt) => {
    const p = evt.payload as { text?: string };
    if (typeof p.text === "string") assistantComplete.push(p.text);
    return { allow: true };
  });
  await streamStructuredJson({
    modelGateway: gateway,
    hooks,
    role: "default_model",
    messages: [{ role: "user", content: "x" }],
    parse: (value) => value,
  });
  assert.deepEqual(assistantDeltas, [fullJson], "exactly one delta with the full chunk text");
  assert.deepEqual(assistantComplete, [fullJson], "complete event with the buffered final text");
});

test("streamStructuredJson: stream() throws → falls back to generateStructuredJsonInQueue", async () => {
  const { gateway, calls } = makeFakeGateway({
    chunks: [],
    throwOnStream: true,
    fallbackResponse: {
      content: JSON.stringify({ assistant_message: "via fallback", tool_calls: [] }),
      provider: "fake",
      model: "fake-model",
      profileName: "default_model",
      role: "default_model",
      finishReason: "stop",
      raw: {},
    },
  });
  const result = await streamStructuredJson<{ assistant_message: string; tool_calls: unknown[] }>({
    modelGateway: gateway,
    role: "default_model",
    messages: [{ role: "user", content: "x" }],
    parse: (value) => value as { assistant_message: string; tool_calls: unknown[] },
  });
  assert.ok(calls.streamCount >= 1, "attempted stream at least once");
  assert.ok(calls.generateCount >= 1, "must have fallen back to generate()");
  assert.equal(result.assistant_message, "via fallback", "fallback result must be returned");
});

test("streamStructuredJson: finishReason=length is rejected and the parser-feedback retry kicks in", async () => {
  // First mode: stream yields length-truncated content → rejected.
  // Second mode: stream yields valid JSON → parsed.
  let attempt = 0;
  const gateway: ModelGateway = {
    async resolveRole() {
      return {
        provider: "fake",
        model: "fake-model",
        profileName: "default_model",
        role: "default_model",
        capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
        timeoutMs: 30_000,
      };
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return {
        content: JSON.stringify({ assistant_message: "via generate", tool_calls: [] }),
        provider: "fake",
        model: "fake-model",
        profileName: "default_model",
        role: request.role,
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      attempt += 1;
      if (attempt === 1) {
        // length-truncated chunk — parser will reject.
        yield { type: "message_start", data: {} };
        yield { type: "message_delta", content: "{ \"assistant_message\": \"trunc" };
        yield { type: "message_end", data: { finishReason: "length" } };
      } else {
        yield { type: "message_start", data: {} };
        yield { type: "message_delta", content: JSON.stringify({ assistant_message: "second attempt ok", tool_calls: [] }) };
        yield { type: "message_end", data: { finishReason: "stop" } };
      }
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return {
        role: request.role,
        profileName: request.role,
        provider: "fake",
        model: "fake-model",
        vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
        raw: {},
      };
    },
    async countTokens(_request: TokenCountRequest): Promise<number> {
      return 0;
    },
  };
  const result = await streamStructuredJson<{ assistant_message: string; tool_calls: unknown[] }>({
    modelGateway: gateway,
    role: "default_model",
    messages: [{ role: "user", content: "x" }],
    parse: (value) => value as { assistant_message: string; tool_calls: unknown[] },
  });
  assert.equal(attempt, 2, "must retry the second mode after length truncation");
  assert.equal(result.assistant_message, "second attempt ok");
});
