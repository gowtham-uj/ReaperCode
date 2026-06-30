/**
 * stream-only-latency.perf.test.ts — measure end-to-end latency from
 * `streamStructuredJson` invocation to the first AssistantMessageDelta
 * hook emission, simulating a 2 s API response time. The user's target:
 * if the API responds in 2 s, text on screen within 3 s.
 *
 * This test bypasses the LangGraph engine and tests the streaming
 * JSON path in isolation. The engine-driven perf test
 * (enter-to-first-delta.test.ts) does the full E2E measurement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { streamStructuredJson } from "../../src/model/json-response.js";
import { Hooks } from "../../src/adaptive/hooks.js";
import type { EmbeddingRequest, EmbeddingResult, GenerateRequest, GenerateResult, ModelGateway, ResolvedModelProfile, StreamEvent, TokenCountRequest } from "../../src/model/types.js";
import type { HookEvent } from "../../src/adaptive/types.js";

const API_LATENCY_MS = 2000;
const CHUNK_INTERVAL_MS = 30;

class FakeGateway implements ModelGateway {
  constructor(private readonly latencyMs: number) {}

  async resolveRole(): Promise<ResolvedModelProfile> {
    return {
      provider: "fake",
      model: "fake-model",
      profileName: "default_model",
      role: "default_model",
      capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
      timeoutMs: 30_000,
    };
  }

  private buildJson(): string {
    return JSON.stringify({
      assistant_message: "Hello, world!",
      tool_calls: [],
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    void request;
    await new Promise((r) => setTimeout(r, this.latencyMs));
    return {
      content: this.buildJson(),
      provider: "fake",
      model: "fake-model",
      profileName: "default_model",
      role: "default_model",
      finishReason: "stop",
      raw: {},
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    void request;
    await new Promise((r) => setTimeout(r, this.latencyMs));
    const full = this.buildJson();
    const step = 8;
    yield { type: "message_start", data: { provider: "fake", model: "fake-model" } };
    for (let i = 0; i < full.length; i += step) {
      yield { type: "message_delta", content: full.slice(i, i + step) };
      await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
    }
    yield { type: "message_end", data: { finishReason: "stop" } };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: request.role,
      profileName: request.role,
      provider: "fake",
      model: "fake-model",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }
  async countTokens(_request: TokenCountRequest): Promise<number> { return 0; }
}

test("perf: streamStructuredJson first delta within API_LATENCY + 1.0s", async () => {
  const gateway = new FakeGateway(API_LATENCY_MS);
  const hooks = new Hooks({ securityFailClosed: false });

  let firstDeltaAt: number | undefined;
  let firstDeltaText: string | undefined;
  hooks.on("AssistantMessageDelta", (evt: HookEvent) => {
    const p = evt.payload as { text?: string };
    const text = String(p.text ?? "");
    if (text && firstDeltaAt === undefined) {
      firstDeltaAt = Date.now();
      firstDeltaText = text;
    }
    return { allow: true };
  });

  const startedAt = Date.now();
  const resultPromise = streamStructuredJson({
    modelGateway: gateway,
    hooks,
    role: "default_model",
    maxTokens: 1024,
    messages: [{ role: "user", content: "hi whats happening" }],
    parse: (value) => {
      const v = value as { assistant_message?: string; tool_calls?: unknown[] };
      return { assistantMessage: v.assistant_message ?? "", toolCalls: v.tool_calls ?? [] };
    },
  });

  // Wait for the parse to complete OR timeout.
  const timeout = new Promise<{ ok: "timeout" }>((resolve) => {
    setTimeout(() => resolve({ ok: "timeout" }), API_LATENCY_MS + 5_000);
  });
  const r = await Promise.race([
    resultPromise.then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e })),
    timeout,
  ]);
  const elapsed = firstDeltaAt ? firstDeltaAt - startedAt : -1;

  console.log(
    `\n[STREAM-PERF] first delta text=${JSON.stringify(firstDeltaText)} elapsed=${elapsed}ms api=${API_LATENCY_MS}ms overhead=${elapsed - API_LATENCY_MS}ms result=${JSON.stringify(r).slice(0, 200)}`,
  );

  assert.ok(firstDeltaAt !== undefined, "first delta must arrive before timeout");
  assert.ok(elapsed >= 0, "elapsed must be non-negative");
  // Streaming alone: budget is API_LATENCY + ~300ms (one chunk emit interval)
  assert.ok(
    elapsed <= API_LATENCY_MS + 500,
    `first-delta ${elapsed}ms exceeds streaming budget ${API_LATENCY_MS + 500}ms`,
  );
});
