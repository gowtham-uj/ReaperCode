import test from "node:test";
import assert from "node:assert/strict";

import { streamMainAgentResponseWithTransportRetry, classifyMainAgentTransportError } from "../../../src/runtime/engine.js";

function okTurn(content = "ok") {
  return {
    content,
    finishReason: "stop",
    toolCalls: [],
    role: "assistant",
    provider: "test",
    model: "test",
    raw: {},
  };
}

// streamMainAgentResponse iterates modelGateway.stream(request). Build an
// async iterable that emits a single "message_end" event with the
// prepared response.
function streamEventsFromTurn(turn: ReturnType<typeof okTurn>) {
  return (async function* () {
    yield { type: "message_start", data: { provider: "test", model: "test" } };
    yield { type: "message_delta", content: turn.content, data: {} };
    yield { type: "message_end", data: { finishReason: turn.finishReason, usage: { promptTokens: 0, completionTokens: 0, inputTokens: 0, outputTokens: 0 } } };
  })();
}

function makeGateway(callImpl: () => Promise<unknown> | unknown) {
  // streamMainAgentResponse does `for await (... of modelGateway.stream(req))`,
  // so stream() must return an async iterable directly. The test gateway
  // materializes a single turn into the standard 3 events.
  return {
    generate: callImpl,
    stream: (_req: any) => {
      const events: any[] = [];
      return {
        async *[Symbol.asyncIterator]() {
          const turn = await callImpl();
          if (turn && typeof (turn as any)[Symbol.asyncIterator] === "function") {
            for await (const ev of turn as AsyncIterable<unknown>) yield ev;
            return;
          }
          const t: any = turn;
          yield { type: "message_start", data: { provider: "test", model: "test" } };
          yield { type: "message_delta", content: t.content, data: {} };
          yield {
            type: "message_end",
            data: {
              finishReason: t.finishReason,
              usage: { promptTokens: 0, completionTokens: 0, inputTokens: 0, outputTokens: 0 },
            },
          };
        },
      };
    },
  } as any;
}

test("classifyMainAgentTransportError: 429 is transport", () => {
  const e = Object.assign(new Error("rate limit"), { status: 429 });
  const t = classifyMainAgentTransportError(e);
  assert.ok(t);
  assert.equal(t.code, "main_agent_transport_error");
});

test("classifyMainAgentTransportError: non-transport error returns undefined", () => {
  const t = classifyMainAgentTransportError(new Error("malformed JSON"));
  assert.equal(t, undefined);
});

test("streamMainAgentResponseWithTransportRetry: returns turn on first success", async () => {
  let calls = 0;
  const gw = makeGateway(async () => {
    calls += 1;
    return okTurn("ok-1");
  });
  const turn = await streamMainAgentResponseWithTransportRetry(gw, {} as any, {
    write: async () => undefined,
  } as any);
  assert.equal(calls, 1);
  assert.equal(turn.content, "ok-1");
});

test("streamMainAgentResponseWithTransportRetry: retries transient failures then succeeds", async () => {
  let calls = 0;
  const gw = makeGateway(async () => {
    calls += 1;
    if (calls < 3) {
      throw Object.assign(new Error("rate limit"), { status: 429 });
    }
    return okTurn("ok-after-retries");
  });
  const turn = await streamMainAgentResponseWithTransportRetry(gw, {} as any, {
    write: async () => undefined,
  } as any);
  assert.ok(calls >= 3);
  assert.equal(turn.content, "ok-after-retries");
});

test("streamMainAgentResponseWithTransportRetry: persistent transport failure surfaces as a model-facing assistant turn, not a thrown error", async () => {
  let calls = 0;
  const gw = makeGateway(async () => {
    calls += 1;
    throw Object.assign(new Error("provider overloaded"), { status: 503 });
  });
  const turn = await streamMainAgentResponseWithTransportRetry(gw, {} as any, {
    write: async () => undefined,
  } as any);
  // 1 initial + 3 retries = 4 attempts.
  assert.equal(calls, 4);
  // No throw. The runtime returns a normal "no tool calls" turn with
  // a transparent message that the model can decide on.
  assert.deepEqual(turn.toolCalls, []);
  assert.ok(typeof turn.content === "string" && turn.content.length > 0);
  assert.match(turn.content, /Reaper note/);
  assert.match(turn.content, /You decide what to do next/);
});

test("streamMainAgentResponseWithTransportRetry: non-transport errors are not retried", async () => {
  let calls = 0;
  const gw = makeGateway(async () => {
    calls += 1;
    throw new Error("malformed JSON");
  });
  await assert.rejects(
    () => streamMainAgentResponseWithTransportRetry(gw, {} as any, { write: async () => undefined } as any),
    /malformed JSON/,
  );
  assert.equal(calls, 1);
});
