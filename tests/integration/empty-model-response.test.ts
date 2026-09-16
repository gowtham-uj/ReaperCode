/**
 * A provider that answers with nothing must not produce a silent turn.
 *
 * DeepInfra's `zai-org/GLM-5.3-Flash` answers byte-identical requests with
 * `finish_reason: "stop"`, a bare `role` delta, and no `content` or
 * `tool_calls` roughly four times in six — verified against the provider
 * directly, streaming, with the exact request Reaper sent. The engine already
 * retried that (`EMPTY_STOP_MAX_RETRIES`), but when the retries ran out it fell
 * through to a terminal stop with an empty assistant message, and the app-server
 * closed the turn as `"completed"`. The user saw their own message, no reply, no
 * error, and no spinner — permanently, with nothing to act on.
 *
 * These tests pin the two ends of that: the engine has to say why it stopped,
 * and the app-server has to translate that into a failed turn.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

/**
 * Streams `message_start` then `message_end` and nothing in between, which is
 * the shape the live provider produces. An `error` event would be the easy
 * case; the failure worth testing is a clean, successful, empty response.
 */
class EmptyStreamGateway implements ModelGateway {
  streamCount = 0;

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "empty-stream",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: false,
        structuredOutput: false,
        embeddings: false,
        maxContextTokens: 128_000,
      },
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.streamCount += 1;
    yield { type: "message_start", data: { provider: "test", model: "empty-stream" } };
    // No message_delta, no tool_call. The empty stop.
    yield {
      type: "message_end",
      data: { finishReason: "stop", usage: { inputTokens: 4169, outputTokens: 15 }, role: request.role },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "empty-stream",
      content: "",
      finishReason: "stop",
      raw: {},
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return { role: request.role, profileName: request.role, provider: "test", model: "empty-stream", vectors: [], raw: {} };
  }

  async countTokens(): Promise<number> {
    return 0;
  }
}

test("a provider that streams nothing is reported, not silently swallowed", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "The page at https://example.com has a heading. Tell me the exact words of it." };

  const gateway = new EmptyStreamGateway();
  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  // The retry ladder still runs first — three attempts, per the empty-stop
  // policy. Asserting the count keeps a future change from quietly turning the
  // ladder off and letting the blocker fire on the first empty response.
  assert.equal(gateway.streamCount, 4, "expected the original call plus three empty-stop retries");

  assert.equal(result.assistantMessage, "", "there was genuinely nothing to say");

  const blocker = (result.runtimeBlockers ?? []).find((entry) => entry.code === "empty_model_response");
  assert.ok(
    blocker,
    "an exhausted empty-stop ladder must record why, or the turn closes as a success with no reply",
  );
  assert.equal(blocker.source, "model");
  // The message is the only thing the user will see, so it has to name the
  // cause and offer a next step rather than restate the symptom.
  assert.match(blocker.message, /empty responses/i);
  assert.match(blocker.message, /again|switch models/i);
});

test("an empty run still reports no blocker when the provider had something to say", async () => {
  // The guard above must key on "the model returned nothing", not on "the
  // assistant message is empty" — a run that ends after tool calls leaves the
  // message empty too, and failing those would break every tool-only turn.
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Write a file." };

  let call = 0;
  const gateway: ModelGateway = {
    streamCount: 0,
    async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
      return {
        role,
        profileName: role,
        provider: "test",
        model: "one-tool",
        capabilities: { streaming: true, toolCalling: true, jsonMode: false, structuredOutput: false, embeddings: false },
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      call += 1;
      yield { type: "message_start", data: {} };
      if (call === 1) {
        yield {
          type: "tool_call",
          data: { id: "w1", name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "hi\n" }) },
        };
        yield { type: "message_end", data: { finishReason: "tool_calls" } };
        return;
      }
      yield { type: "message_delta", content: "Wrote out.txt." };
      yield { type: "message_end", data: { finishReason: "stop" } };
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "one-tool", content: "", finishReason: "stop", raw: {} };
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "one-tool", vectors: [], raw: {} };
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  } as ModelGateway;

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();
  assert.equal(
    (result.runtimeBlockers ?? []).some((entry) => entry.code === "empty_model_response"),
    false,
    "a turn that produced tool calls is not an empty response",
  );
});

/**
 * A model that thinks and then stops without answering.
 *
 * This is the other half of the same bug, and the more misleading one. The
 * empty-stop counter tests `assistantText` only, so a reasoning model that
 * returns thinking on every turn but never a summary was counted as returning
 * "3 empty responses in a row" and the run was killed with a message telling
 * the user to check their provider. The provider was fine: it sent reasoning
 * every single time.
 */
test("a reasoning-only stop is not counted as an empty response", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Summarise what the failing test proves." };

  let calls = 0;
  const gateway: ModelGateway = {
    streamCount: 0,
    async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
      return {
        role,
        profileName: role,
        provider: "test",
        model: "thinking-only",
        capabilities: { streaming: true, toolCalling: true, jsonMode: false, structuredOutput: false, embeddings: false },
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      calls += 1;
      yield { type: "message_start", data: {} };
      /*
       * Reasoning on the channel, no content, and a clean stop — the shape an
       * OpenAI-compatible reasoning model produces when it thinks and then ends
       * the turn without committing to an answer.
       */
      yield { type: "reasoning_delta", content: `thinking, pass ${calls}` } as StreamEvent;
      yield { type: "message_end", data: { finishReason: "stop" } };
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "thinking-only", content: "", finishReason: "stop", raw: {} };
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "thinking-only", vectors: [], raw: {} };
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  } as ModelGateway;

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();

  const emptyBlocker = (result.runtimeBlockers ?? []).find((entry) => entry.code === "empty_model_response");
  assert.equal(
    emptyBlocker,
    undefined,
    "a turn that carried reasoning must not be reported as an empty response; the provider did send something",
  );

  /*
   * It is still nudged, because thinking without answering is not a finished
   * turn, but on its own budget: the model gets more exchanges and the run ends
   * with a message that names what happened rather than blaming the transport.
   */
  if (result.runtimeBlockers?.some((entry) => entry.code === "reasoning_without_answer")) {
    assert.match(
      result.runtimeBlockers.find((entry) => entry.code === "reasoning_without_answer")!.message,
      /thinking/i,
    );
  }
  assert.ok(calls > 1, "a reasoning-only stop should be nudged toward an answer, not accepted as final");
});

test("reasoning alongside real text is an ordinary turn", async () => {
  // The common shape: a reasoning model that thinks and then answers. Nothing
  // about the new reasoning branch may flag this.
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Say hello." };

  const gateway: ModelGateway = {
    streamCount: 0,
    async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
      return {
        role,
        profileName: role,
        provider: "test",
        model: "think-and-answer",
        capabilities: { streaming: true, toolCalling: true, jsonMode: false, structuredOutput: false, embeddings: false },
      };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "message_start", data: {} };
      yield { type: "reasoning_delta", content: "the user wants a greeting" } as StreamEvent;
      yield { type: "message_delta", content: "Hello." };
      yield { type: "message_end", data: { finishReason: "stop" } };
    },
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "think-and-answer", content: "Hello.", finishReason: "stop", raw: {} };
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return { role: request.role, profileName: request.role, provider: "test", model: "think-and-answer", vectors: [], raw: {} };
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  } as ModelGateway;

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
  });

  const result = await engine.run();
  assert.equal(result.assistantMessage, "Hello.");
  assert.equal(result.runtimeBlockers?.length ?? 0, 0, "an answered turn has nothing to block on");
});
