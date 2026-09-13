/**
 * A model call that throws has to end the turn as a failure with something to
 * read, not as a success with nothing to read.
 *
 * This is the third shape of the same bug, and the one that survived the first
 * two fixes. `empty-model-response.test.ts` covers a provider that answers with
 * nothing; the transport-error path covers a provider that refuses with a
 * status. This file covers everything else: the model call throws, the error is
 * not one the transport classifier claims, and the engine's `catch` used to
 * write the error text into `assistantMessage` as though the model had said it.
 *
 * The consequence was not subtle. Nothing emitted an assistant message, so the
 * transcript stayed empty; nothing raised a blocker, so `task_completed` fired
 * and the turn closed `completed`. The screen showed the user's own message and
 * then nothing — no reply, no error, no spinner, permanently. That is the exact
 * state the screenshot in `tool-discovery-findings.md` records.
 *
 * The engine, the loop and the thread manager here are real. The gateway is the
 * only fake, because the gateway is the only part that reaches a provider.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { ReaperThreadManager } from "../../src/app-server/thread-manager.js";
import { RuntimeEngine, classifyMainAgentTransportError } from "../../src/runtime/engine.js";
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
 * Throws on every stream call with an error the transport classifier does not
 * recognise — no `status` property, no `HTTP <code>` in the text. Modelled on a
 * provider answering 200 with a body the client cannot parse.
 */
class ThrowingGateway implements ModelGateway {
  streamCount = 0;
  constructor(private readonly error: Error) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "throwing",
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

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.streamCount += 1;
    throw this.error;
    // eslint-disable-next-line no-unreachable
    yield { type: "message_start" };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "throwing",
      content: "",
      finishReason: "stop",
      raw: {},
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return { role: request.role, profileName: request.role, provider: "test", model: "throwing", vectors: [], raw: {} };
  }

  async countTokens(_request: TokenCountRequest): Promise<number> {
    return 0;
  }
}

async function runFailingTurn(error: Error) {
  const workspaceRoot = await createTempWorkspace();
  const dataRoot = `${workspaceRoot}/.reaper/threads`;
  const gateway = new ThrowingGateway(error);

  const notifications: Array<{ type: string; [k: string]: unknown }> = [];
  const manager = new ReaperThreadManager({
    dataRoot,
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

  const thread = await manager.startThread({ title: "failing turn", workspaceRoot });
  thread.subscribe("test", (record) => {
    notifications.push(record.event as unknown as { type: string; [k: string]: unknown });
  });

  const handle = await thread.startTurn({ prompt: "Summarise this repository." });
  const summary = await handle.completion;
  await manager.shutdown();
  return {
    notifications,
    summary: summary as unknown as { status: string; error?: { name?: string; message?: string } },
  };
}

test("a model call that throws closes the turn as failed", async () => {
  const { notifications, summary } = await runFailingTurn(
    new Error("Response body was not valid JSON."),
  );

  assert.equal(
    summary.status,
    "failed",
    "a model call that threw must not close the turn as completed",
  );
  assert.equal(summary.error?.name, "model_call_failed");

  const failed = notifications.find((entry) => entry.type === "turn.failed");
  assert.ok(
    failed,
    `expected turn.failed, got: ${JSON.stringify(notifications.map((n) => n.type))}`,
  );
  assert.equal(
    notifications.some((entry) => entry.type === "turn.completed"),
    false,
    "turn.completed must not accompany turn.failed — the transcript would flash success then flip",
  );
});

test("the failure names the cause and offers a next step", async () => {
  const { summary } = await runFailingTurn(new Error("Response body was not valid JSON."));
  const message = summary.error?.message ?? "";

  // The provider's own words have to survive: without them the user cannot tell
  // a bad key from an outage from a malformed response, and those need
  // different actions.
  assert.match(message, /Response body was not valid JSON/);
  // And the message has to say what to do. `Transcript.tsx` renders it verbatim
  // behind a ✕, so a bare error string is a dead end on screen.
  assert.match(message, /again|switch models/i);
});

test("a status written into the message text is still a transport error", () => {
  // The Anthropic client builds its errors as plain `Error`s with the status
  // baked into the string, so `error.status` is undefined and the classifier
  // used to wave through the very failures it exists to catch. Real text,
  // copied from the gateway's own log line.
  const classified = classifyMainAgentTransportError(
    new Error(
      "Anthropic stream failed: HTTP 502 - " +
        '{"type":"error","error":{"type":"api_error","message":"unknown provider for model claude-sonnet-4-6"}}',
    ),
  );
  assert.ok(classified, "an HTTP 502 in the message text must classify as a transport error");
  assert.equal(classified.code, "main_agent_transport_error");
  assert.match(classified.details.join(" "), /status=502/);
});

test("a non-status error is not mistaken for a transport error", () => {
  // The match is anchored on `HTTP <code>` for this reason: a bare three-digit
  // number in an otherwise ordinary message must not be read as a status, or
  // the run would enter a retry ladder it cannot make progress in.
  assert.equal(classifyMainAgentTransportError(new Error("input is 4012 tokens long")), undefined);
  assert.equal(classifyMainAgentTransportError(new Error("Model returned no choices")), undefined);
});
