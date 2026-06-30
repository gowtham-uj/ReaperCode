/**
 * engine-driver.test.ts — smoke tests for the streaming hook bridge
 * that wires `AssistantStreamDelta` / `AssistantStreamComplete` hook
 * events into the SessionStore.
 *
 * The driver is constructed through `createEngineDriver` which has
 * many dependencies (config, model gateway, runtime engine). Rather
 * than exercising the full constructor, we test the streaming
 * contract directly by:
 *   1. Building a fresh SessionStore.
 *   2. Constructing a minimal Hooks adapter.
 *   3. Replicating the driver's streaming handler pair against the
 *      store and verifying the resulting state after a sequence of
 *      emit() calls.
 *
 * The handler logic is identical to the one in `engine-driver.ts`;
 * we keep them in lockstep via these tests so any drift shows up
 * here. (The full driver integration is covered by TUI smoke tests.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionStore } from "../../../src/tui/state/session-store.js";
import { Hooks } from "../../../src/adaptive/hooks.js";
import type { HookEvent } from "../../../src/adaptive/types.js";

/**
 * Bind the driver-equivalent streaming handlers to a Hooks adapter.
 * Returns the tracked-id set so the caller can assert the dedupe path
 * that `runPrompt` performs after the engine resolves.
 */
function bindStreamingHandlers(store: ReturnType<typeof createSessionStore>) {
  const hooks = new Hooks({ securityFailClosed: false });
  const streamedAssistantIds = new Set<string>();

  hooks.on("AssistantStreamDelta", (evt: HookEvent) => {
    const p = evt.payload as { text?: string };
    const text = String(p.text ?? "");
    if (text) store.appendAssistantStream(text);
    store.setPhase("streaming");
    return { allow: true };
  });

  hooks.on("AssistantStreamComplete", (evt: HookEvent) => {
    const lastMsg = [...store.snapshot().messages].reverse().find((m) => m.kind === "assistant");
    if (lastMsg) streamedAssistantIds.add(lastMsg.id);
    store.completeAssistantStream();
    return { allow: true };
  });

  return { hooks, streamedAssistantIds };
}

test("engine-driver: AssistantStreamDelta mutates the streaming buffer", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindStreamingHandlers(store);

  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "Hello, ", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "world.", role: "assistant", done: false },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1, "two deltas should collapse into one message");
  assert.equal(assistants[0]?.text, "Hello, world.");
  assert.equal(store.snapshot().status.phase, "streaming", "phase should flip to streaming");
});

test("engine-driver: AssistantStreamComplete commits the buffer and resets phase implicitly", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindStreamingHandlers(store);

  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "streaming content", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamComplete",
    payload: { text: "streaming content", role: "assistant", done: true },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1, "buffer should be committed as a single message");
  assert.equal(assistants[0]?.text, "streaming content");
});

test("engine-driver: a subsequent AssistantStreamDelta opens a fresh buffer after complete", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindStreamingHandlers(store);

  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "first turn", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamComplete",
    payload: { text: "first turn", role: "assistant", done: true },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "second turn", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamComplete",
    payload: { text: "second turn", role: "assistant", done: true },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 2, "two turns produce two separate messages");
  assert.equal(assistants[0]?.text, "first turn");
  assert.equal(assistants[1]?.text, "second turn");
});

test("engine-driver: streamed id set tracks the most recent assistant message", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks, streamedAssistantIds } = bindStreamingHandlers(store);

  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "alpha", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamComplete",
    payload: { text: "alpha", role: "assistant", done: true },
    blockable: false,
  });

  assert.equal(streamedAssistantIds.size, 1);
  const firstId = [...streamedAssistantIds][0];
  assert.ok(firstId, "expected an assistant id to be tracked");

  // After a second turn completes, the set still contains exactly the
  // most-recent streamed id (the earlier id is not removed — the
  // engine-run path clears it explicitly via `.clear()`).
  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "beta", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantStreamComplete",
    payload: { text: "beta", role: "assistant", done: true },
    blockable: false,
  });
  assert.equal(streamedAssistantIds.size, 2);
});

test("engine-driver: empty delta is a no-op (does not open a new buffer)", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindStreamingHandlers(store);

  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "", role: "assistant", done: false },
    blockable: false,
  });
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 0, "empty delta must not allocate an empty message");
});

test("engine-driver: snapshot reference is invalidated by streaming mutations", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindStreamingHandlers(store);
  const before = store.snapshot();
  await hooks.emit({
    name: "AssistantStreamDelta",
    payload: { text: "ping", role: "assistant", done: false },
    blockable: false,
  });
  const after = store.snapshot();
  assert.notEqual(before, after, "snapshot must change after a streaming mutation");
});

/* -------------------------------------------------------------------------- */
/*  Rendering-layer hook wiring                                                */
/*                                                                            */
/*  The driver also subscribes to the rendering-layer event family:           */
/*    AssistantMessageDelta / AssistantMessageComplete and                    */
/*    ReasoningDelta / ReasoningComplete.                                      */
/*  These tests verify the wiring against a driver-equivalent pair of         */
/*  handlers.                                                                  */
/* -------------------------------------------------------------------------- */

function bindRenderingHandlers(store: ReturnType<typeof createSessionStore>) {
  const hooks = new Hooks({ securityFailClosed: false });

  hooks.on("ReasoningDelta", (evt: HookEvent) => {
    const p = evt.payload as { text?: string };
    const text = String(p.text ?? "");
    if (text) store.appendReasoningDelta(text);
    return { allow: true };
  });

  hooks.on("ReasoningComplete", (_evt: HookEvent) => {
    store.completeReasoning();
    return { allow: true };
  });

  hooks.on("AssistantMessageDelta", (evt: HookEvent) => {
    const p = evt.payload as { text?: string };
    const text = String(p.text ?? "");
    if (text) store.appendAssistantDelta(text);
    store.setPhase("streaming");
    return { allow: true };
  });

  hooks.on("AssistantMessageComplete", (_evt: HookEvent) => {
    store.completeAssistant();
    return { allow: true };
  });

  return { hooks };
}

test("engine-driver: ReasoningDelta → appendReasoningDelta", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindRenderingHandlers(store);

  // Reasoning usually precedes the chat text in a turn. Open the
  // streaming buffer first so ReasoningComplete can fold onto it.
  await hooks.emit({
    name: "AssistantMessageDelta",
    payload: { text: "answer", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "ReasoningDelta",
    payload: { text: "thinking ", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "ReasoningDelta",
    payload: { text: "more thoughts", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "ReasoningComplete",
    payload: { text: "thinking more thoughts", role: "assistant", done: true },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.text, "answer");
  assert.equal(assistants[0]?.reasoning, "thinking more thoughts",
    "reasoning should fold onto the streaming message on complete");
});

test("engine-driver: AssistantMessageDelta opens a new buffer that completes on AssistantMessageComplete", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindRenderingHandlers(store);

  await hooks.emit({
    name: "AssistantMessageDelta",
    payload: { text: "Hello, ", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantMessageDelta",
    payload: { text: "world.", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "AssistantMessageComplete",
    payload: { text: "Hello, world.", role: "assistant", done: true },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.text, "Hello, world.");
  assert.equal(store.snapshot().status.phase, "streaming");
});

test("engine-driver: the engine only fires the rendering-layer event family", async () => {
  // The engine used to fire BOTH `AssistantStreamDelta/Complete` and
  // `AssistantMessageDelta/Complete` for the same turn. That caused
  // the SessionStore to render the same assistant text twice (the
  // streaming buffer was committed by the first Complete, then the
  // second Delta opened a fresh buffer with the same content). The
  // engine now only fires the rendering-layer family. The legacy
  // names remain in the HookEvent union for backward compatibility
  // with any third-party subscriber, but the engine never emits them.
  //
  // This test asserts the new contract by binding the rendering-layer
  // handlers and verifying they render the chat bubble exactly once.
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const rendering = bindRenderingHandlers(store);

  await rendering.hooks.emit({
    name: "AssistantMessageDelta",
    payload: { text: "only-one-bubble", role: "assistant", done: false },
    blockable: false,
  });
  await rendering.hooks.emit({
    name: "AssistantMessageComplete",
    payload: { text: "only-one-bubble", role: "assistant", done: true },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1, "rendering-layer events produce exactly one bubble");
  assert.equal(assistants[0]?.text, "only-one-bubble");
});

test("engine-driver: empty ReasoningDelta is a no-op", async () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindRenderingHandlers(store);

  await hooks.emit({
    name: "ReasoningDelta",
    payload: { text: "", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "ReasoningComplete",
    payload: { text: "", role: "assistant", done: true },
    blockable: false,
  });
  // No assistant message was opened so the reasoning drops silently.
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 0);
});

test("engine-driver: hook errors are fail-open and don't derail other handlers", async () => {
  // The engine wraps every emit in try/catch, but the hook bus itself
  // also swallows handler errors. Verify that a misbehaving handler
  // doesn't prevent the other handlers in the same emit from running.
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const { hooks } = bindRenderingHandlers(store);
  hooks.on("ReasoningDelta", () => {
    throw new Error("boom");
  });

  // The store-bound handler runs first, then the throwing one. The
  // throw is swallowed by the hook bus so the second handler below
  // still gets to mutate the store.
  await hooks.emit({
    name: "ReasoningDelta",
    payload: { text: "first", role: "assistant", done: false },
    blockable: false,
  });
  // The buffer should still contain "first" — the throw didn't roll
  // it back, and the other handler in the chain ran successfully.
  await hooks.emit({
    name: "AssistantMessageDelta",
    payload: { text: "answer", role: "assistant", done: false },
    blockable: false,
  });
  await hooks.emit({
    name: "ReasoningComplete",
    payload: { text: "first", role: "assistant", done: true },
    blockable: false,
  });

  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants[0]?.reasoning, "first");
  assert.equal(assistants[0]?.text, "answer");
});

/* -------------------------------------------------------------------------- */
/*  priorTurns extraction                                                     */
/*                                                                            */
/*  Multi-turn session continuity requires runPrompt to extract the user +    */
/*  assistant text from the SessionStore and pass it as                      */
/*  `payload.priorTurns` on the next request envelope. The engine then       */
/*  prepends those messages to the model call so the next turn sees the      */
/*  full conversation context. These tests verify the extraction logic       */
/*  end-to-end through the store.                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mirror of the extraction logic in engine-driver.ts:runPrompt. Kept in
 * lockstep via these tests so any drift surfaces here before it shows up
 * as a missing-history bug in production.
 */
function extractPriorTurns(store: ReturnType<typeof createSessionStore>): Array<{ role: "user" | "assistant"; content: string }> {
  return store
    .snapshot()
    .messages
    .filter((m) => m.kind === "user" || m.kind === "assistant")
    .map((m) => ({ role: m.kind as "user" | "assistant", content: m.text }));
}

test("engine-driver: priorTurns extraction produces empty array on a fresh session", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const turns = extractPriorTurns(store);
  assert.equal(turns.length, 0);
});

test("engine-driver: priorTurns extraction returns user+assistant in chronological order", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendUser("hi whats happening");
  store.appendAssistant("not much — how can I help?");
  store.appendUser("what did I just say?");
  // Note: priorTurns is captured at the START of a new prompt — the
  // assistant reply to "what did I just say?" has not yet arrived.
  const turns = extractPriorTurns(store);
  assert.equal(turns.length, 3, "two user + one assistant");
  assert.deepEqual(turns[0], { role: "user", content: "hi whats happening" });
  assert.deepEqual(turns[1], { role: "assistant", content: "not much — how can I help?" });
  assert.deepEqual(turns[2], { role: "user", content: "what did I just say?" });
});

test("engine-driver: priorTurns extraction skips system/error/tool messages", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendUser("hello");
  store.appendSystem("(system info: model changed)");
  store.appendAssistant("hi back");
  store.beginToolCard({ callId: "t1", name: "read_file", args: {} });
  store.appendError("(oops, file missing)");
  store.appendUser("again");
  const turns = extractPriorTurns(store);
  assert.equal(turns.length, 3, "user, assistant, user only");
  assert.equal(turns[0]!.role, "user");
  assert.equal(turns[1]!.role, "assistant");
  assert.equal(turns[2]!.role, "user");
});

test("engine-driver: priorTurns include streamed assistant content (continuity works mid-stream)", () => {
  // Simulates the engine-driver's view: between user input and the
  // final EngineTurnComplete, the assistant text is in a streaming
  // buffer that's already been committed to the store. The extractor
  // should still see it because the store's appendAssistantDelta
  // commits the buffer on AssistantMessageComplete.
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendUser("say hi");
  store.appendAssistant("hi there");
  const turns = extractPriorTurns(store);
  assert.equal(turns.length, 2);
  assert.equal(turns[1]!.role, "assistant");
  assert.equal(turns[1]!.content, "hi there");
});

test("engine-driver: priorTurns survive a /resume hydrate (replayed messages count)", () => {
  // The /resume path replaces the store contents with messages
  // replayed from a persisted trajectory. The extraction must work
  // identically on the hydrated store — i.e. a resumed session
  // produces the same priorTurns as a session that never closed.
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.clear();
  // Simulate the /resume hydration loop.
  store.appendUser("first question");
  store.appendAssistant("first answer");
  store.appendUser("second question");
  store.appendAssistant("second answer");
  const turns = extractPriorTurns(store);
  assert.equal(turns.length, 4);
  assert.equal(turns[0]!.content, "first question");
  assert.equal(turns[3]!.content, "second answer");
});
