/**
 * The far end of the empty-response fix: what the browser is actually told.
 *
 * `empty-model-response.test.ts` proves the engine records a blocker.
 * `managed-thread` is the only thing that turns a blocker into a turn status,
 * and it used to hardcode `"completed"` — so this test drives the real engine,
 * through the real thread manager, and reads the notification the React store
 * folds into `AppTurn.error`, which `Transcript.tsx` renders as
 * `<p role="alert">✕ …</p>`.
 *
 * Nothing here is stubbed except the model itself. An earlier draft of this file
 * replaced the turn runner with a fake that returned a hand-written blocker
 * message, and one of its assertions then passed by checking text that the
 * production code never produced — a test of the test. The gateway is the only
 * seam, because the gateway is the only part of this that talks to a provider.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { ReaperThreadManager } from "../../src/app-server/thread-manager.js";
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
 * Streams `message_start` then `message_end` and nothing in between — the shape
 * DeepInfra's GLM-5.3-Flash actually produces. An `error` event would be the
 * easy case; the failure worth testing is a clean, successful, empty response.
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

  async countTokens(_request: TokenCountRequest): Promise<number> {
    return 0;
  }
}

async function runEmptyTurn() {
  const workspaceRoot = await createTempWorkspace();
  const dataRoot = `${workspaceRoot}/.reaper/threads`;
  const gateway = new EmptyStreamGateway();

  const notifications: Array<{ type: string; [k: string]: unknown }> = [];
  const manager = new ReaperThreadManager({
    dataRoot,
    // The real engine, the real loop, the real blocker. Only the model is fake.
    turnRunner: async (input) => {
      const request = createValidRequestEnvelope();
      request.payload = { prompt: input.prompt };
      const engine = new RuntimeEngine({
        config: createValidConfig(),
        workspaceRoot: input.workspaceRoot,
        requestEnvelope: request,
        modelGateway: gateway,
        eventSink: input.eventSink,
        abortSignal: input.abortSignal,
      });
      return await engine.run();
    },
  });

  const thread = await manager.startThread({ title: "empty turn", workspaceRoot });
  thread.subscribe("test", (record) => {
    notifications.push(record.event as unknown as { type: string; [k: string]: unknown });
  });

  const handle = await thread.startTurn({
    prompt: "The page at https://example.com has a heading. Tell me the exact words of it.",
  });
  const summary = await handle.completion;
  await manager.shutdown();
  return { notifications, summary: summary as unknown as { status: string; error?: { message: string } }, streamCount: gateway.streamCount };
}

test("a turn whose model said nothing closes as failed, not completed", async () => {
  const { notifications, summary, streamCount } = await runEmptyTurn();

  assert.equal(streamCount, 4, "expected the original call plus three empty-stop retries");

  assert.equal(
    summary.status,
    "failed",
    "a run that produced no reply must not be reported as a completed turn",
  );

  const failed = notifications.find((entry) => entry.type === "turn.failed");
  assert.ok(failed, `expected a turn.failed notification, got: ${JSON.stringify(notifications.map((n) => n.type))}`);
  const error = failed.error as { name?: string; message?: string } | undefined;
  assert.equal(error?.name, "empty_model_response");

  // The success notification must be absent. Publishing both would let the
  // transcript mark the turn done before the error lands, and the status the
  // user sees would depend on which frame arrived second.
  assert.equal(
    notifications.some((entry) => entry.type === "turn.completed"),
    false,
    "a failed turn must not also publish turn.completed",
  );
});

test("the failure carries enough text to render and act on", async () => {
  const { summary } = await runEmptyTurn();
  const message = summary.error?.message ?? "";
  // `Transcript.tsx` renders this string verbatim behind a ✕. A bare error code
  // would render as a glyph the user cannot interpret, so the assertion is on
  // the sentence the engine writes, read back out the far end of the path.
  assert.ok(message.length > 40, `the rendered error is too terse to be useful: ${JSON.stringify(message)}`);
  assert.match(message, /empty responses/i);
  assert.match(message, /again|switch models/i, "the error must offer a next step, not just state the symptom");
});
