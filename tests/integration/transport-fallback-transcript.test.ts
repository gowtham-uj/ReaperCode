/**
 * What the transcript is allowed to show when the provider fails every retry.
 *
 * The engine has two channels out of a turn: the event sink, which the browser
 * folds into transcript items, and the blocker, which becomes the turn's status
 * and its error line. They are separate on purpose and this file is about them
 * staying separate.
 *
 * They were not. The synthetic "transport fallback" turn — a stand-in the retry
 * helper builds once the provider has refused every attempt — was emitted to the
 * event sink like any other model turn, so its text became an assistant reply.
 * That text is a note addressed to the model ("you decide what to do next:
 * stop and write a final summary, keep working with the results you already
 * have"), and the blocker is built from the same words, so a user saw the
 * paragraph twice: once as the model talking to itself, once as the failure.
 * The screenshot in `tool-discovery-findings.md` shows both.
 *
 * The model still needs the note in its own conversation. The assertion here is
 * narrower than "the note is gone" — it is that the note never becomes a
 * transcript item.
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
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

/**
 * A provider that is up, answering, and failing — the shape a real outage has.
 * The Anthropic client reports it as a plain `Error` with the status in the
 * text, which is what this reproduces.
 */
class RefusingGateway implements ModelGateway {
  streamCount = 0;

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      capabilities: {
        streaming: true,
        toolCalling: true,
        jsonMode: false,
        structuredOutput: false,
        embeddings: false,
        maxContextTokens: 200_000,
      },
    };
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.streamCount += 1;
    throw new Error(
      "Anthropic stream failed: HTTP 502 - "
      + '{"type":"error","error":{"type":"api_error","message":"unknown provider for model claude-sonnet-4-6"}}',
    );
    // eslint-disable-next-line no-unreachable
    yield { type: "message_start" };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return {
      role: request.role,
      profileName: request.role,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      content: "",
      finishReason: "stop",
      raw: {},
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return { role: request.role, profileName: request.role, provider: "anthropic", model: "x", vectors: [], raw: {} };
  }

  async countTokens(_request: TokenCountRequest): Promise<number> {
    return 0;
  }
}

async function runRefusedTurn() {
  const workspaceRoot = await createTempWorkspace();
  const gateway = new RefusingGateway();
  const events: RuntimeEvent[] = [];
  const request = createValidRequestEnvelope();
  request.payload = { prompt: "Say hello in one word." };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
    modelGateway: gateway,
    eventSink: (event) => {
      events.push(event as RuntimeEvent);
    },
  });

  const result = await engine.run();
  const assistantTexts = events
    .filter((event) => event.type === "assistant.message.completed")
    .map((event) => (event as { text: string }).text);
  return { result, events, assistantTexts, streamCount: gateway.streamCount };
}

test("a refused provider does not put runtime instructions in the transcript", async () => {
  const { assistantTexts, result, streamCount } = await runRefusedTurn();

  assert.ok(streamCount > 1, "expected the retry ladder to run before giving up");

  const joined = assistantTexts.join("\n");
  // The tell is the note's own voice. It is written to the model, so it talks
  // about "your last model call" and tells the reader what to do next — an
  // assistant reply that reads like an operator console is the bug.
  assert.doesNotMatch(
    joined,
    /Your last model call failed|You decide what to do next/,
    "the runtime's note to the model must not be emitted as an assistant reply",
  );
  assert.equal(assistantTexts.length, 0, `expected no assistant transcript text, got: ${JSON.stringify(assistantTexts)}`);
  assert.equal(result.assistantMessage, "");
});

test("the failure is reported once, in the blocker, with the cause attached", async () => {
  const { result, events } = await runRefusedTurn();

  const blocker = (result.runtimeBlockers ?? []).find((entry) => entry.code === "main_agent_transport_error");
  assert.ok(blocker, `expected a transport blocker, got: ${JSON.stringify(result.runtimeBlockers ?? [])}`);

  // The user-facing sentence: which provider, what status, and what to do.
  assert.match(blocker.message, /502/);
  assert.match(blocker.message, /again|switch models/i);
  // And the provider's own words survive the trip, because "unknown provider for
  // model claude-sonnet-4-6" is the difference between a wrong model name and a
  // general outage — different problems, different fixes.
  assert.match(blocker.message, /unknown provider for model/);

  // A run that stopped short must not announce a completed turn either, or the
  // transcript marks it done before the failure lands.
  assert.equal(
    events.some((event) => event.type === "turn.completed"),
    false,
    "turn.completed must not be emitted for a run that stopped short",
  );
});
