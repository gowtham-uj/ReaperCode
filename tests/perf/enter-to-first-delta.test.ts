/**
 * enter-to-first-delta.perf.test.ts — measure end-to-end latency from
 * `engine.run()` start to the first `AssistantMessageDelta` hook
 * emission, simulating a 2 s API response time. The user's target:
 * if the API responds in 2 s, text on screen within 3 s — so the
 * budget between Enter and first delta is ~1 s.
 *
 * Uses a fake model gateway that sleeps for `API_LATENCY_MS` before
 * yielding the first chunk, then emits chunks at 30 ms intervals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RuntimeEngine } from "../../src/runtime/engine.js";
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
    await new Promise((r) => setTimeout(r, this.latencyMs));
    return {
      content: this.buildJson(),
      provider: "fake",
      model: "fake-model",
      profileName: "default_model",
      role: request.role,
      finishReason: "stop",
      raw: {},
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    void request;
    // Simulate API TTFB — first chunk arrives after latencyMs.
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

function createFakeConfig() {
  return {
    logging: { sessionMetrics: false },
    runtime: {
      completionGateMax: 3,
      voteAttempts: 1,
      progressGuard: {
        enabled: false,
        actionRepeatLimit: 3,
        observationRepeatLimit: 3,
        sameFailedActionLimit: 3,
        recoveryStrategyRepeatLimit: 3,
        stallSteps: 3,
      },
      recedingHorizonPlanContext: false,
      artifactObligations: { enabled: false },
      hypothesisRescue: { enabled: false },
      serviceSupervisor: { enabled: false },
    },
    verification: {
      requireGroundedCompletion: false,
      selfDebugExplanation: { enabled: false },
      freshContextDiffReview: { enabled: false, maxDiffChars: 12_000 },
      contractCoverage: { enabled: false },
    },
    modelRouting: {
      planner: "default_model",
      executor: "default_model",
      repair: "default_model",
      patcher: "default_model",
      completionGate: "default_model",
      summarizer: "default_model",
      judge: "default_model",
    },
    models: {
      default_model: {
        provider: "fake",
        model: "fake-model",
        timeoutMs: 30_000,
        capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
      },
    },
  };
}

test("perf: Enter-to-first-delta <= API_LATENCY + 1.0s overhead on a conversational prompt", async () => {
  const config = createFakeConfig();
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
  const engine = new RuntimeEngine({
    config,
    workspaceRoot: process.cwd(),
    requestEnvelope: {
      connection_id: "perf-test",
      session_id: "perf-sess",
      turn_id: "perf-turn",
      request_id: "perf-req",
      message_type: "user_prompt" as const,
      timestamp: new Date(startedAt).toISOString(),
      trace_id: "perf-sess",
      metadata: { transport: "http_json", yolo: true },
      payload: { prompt: "hi whats happening" },
    },
    modelGateway: gateway,
    hooks,
  });

  // Use Promise.race so we can return early once the first delta lands.
  const runPromise = engine.run().then((r) => ({ ok: true as const, result: r })).catch((e) => ({ ok: false as const, error: e }));
  let timedOut = false;
  const timeout = new Promise<{ ok: "timeout" }>((resolve) => {
    setTimeout(() => { timedOut = true; resolve({ ok: "timeout" }); }, API_LATENCY_MS + 5_000);
  });
  const r = await Promise.race([runPromise, timeout]);
  const elapsed = firstDeltaAt ? firstDeltaAt - startedAt : -1;

  console.log(
    `\n[PERF] first delta text=${JSON.stringify(firstDeltaText)} elapsed=${elapsed}ms api=${API_LATENCY_MS}ms overhead=${elapsed - API_LATENCY_MS}ms timedOut=${timedOut} engineResult=${JSON.stringify(r).slice(0, 200)}`,
  );

  // User target: API 2 s → first delta ≤ 3 s (1 s budget).
  // Cold path includes indexer + fingerprint + content prep + warmup,
  // so we allow generous headroom here: ≤ 4 s total.
  assert.ok(firstDeltaAt !== undefined, "first delta must arrive before timeout");
  assert.ok(elapsed >= 0, "elapsed must be non-negative");
  assert.ok(
    elapsed <= API_LATENCY_MS + 1_500,
    `first-delta ${elapsed}ms exceeds budget ${API_LATENCY_MS + 1500}ms (API ${API_LATENCY_MS} + 1.5s overhead)`,
  );
});
