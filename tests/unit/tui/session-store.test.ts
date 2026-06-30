/**
 * session-store — invariant tests for the React 19
 * useSyncExternalStore bridge.
 *
 * The store must hand out a STABLE snapshot reference between
 * mutations, otherwise useSyncExternalStore re-renders forever
 * (the dreaded "The result of getSnapshot should be cached to
 * avoid an infinite loop" + "Maximum update depth exceeded").
 *
 * After any mutation, the next snapshot() call must return a
 * NEW reference, otherwise React won't see a state change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionStore } from "../../../src/tui/state/session-store.js";

test("session-store: snapshot reference is stable across multiple reads", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const a = store.snapshot();
  const b = store.snapshot();
  const c = store.snapshot();
  assert.equal(a, b, "second snapshot() should return the cached reference");
  assert.equal(b, c, "third snapshot() should return the cached reference");
});

test("session-store: snapshot reference changes after a mutation", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const a = store.snapshot();
  store.appendUser("hello");
  const b = store.snapshot();
  assert.notEqual(a, b, "mutation must invalidate the cached snapshot");
  // And is now stable again.
  const c = store.snapshot();
  assert.equal(b, c, "subsequent snapshot() calls return the cached reference");
});

test("session-store: each mutation produces a fresh snapshot reference", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const seen: unknown[] = [store.snapshot()];
  store.appendUser("a");
  seen.push(store.snapshot());
  store.appendAssistant("b");
  seen.push(store.snapshot());
  store.appendSystem("c");
  seen.push(store.snapshot());
  store.setPhase("streaming");
  seen.push(store.snapshot());
  // All references must be distinct.
  const distinct = new Set(seen);
  assert.equal(distinct.size, seen.length, "every mutation should produce a unique snapshot");
});

test("session-store: notify() invalidates the cache before listeners run", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const before = store.snapshot();
  let observedInListener: unknown = undefined;
  const unsub = store.subscribe(() => {
    // During the notification, snapshot() must reflect the new state
    // (cache has been invalidated). Read the message list length.
    observedInListener = store.snapshot();
  });
  store.appendUser("triggered");
  unsub();
  assert.notEqual(observedInListener, before, "listener should see a fresh snapshot");
  assert.equal((observedInListener as { messages: unknown[] }).messages.length, 2,
    "listener should see the new user message in its snapshot");
});

test("session-store: snapshot.messages / snapshot.toolCards are also stable", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const a = store.snapshot();
  store.appendUser("hi");
  const b = store.snapshot();
  // After the mutation, the new snapshot's arrays are stable until the next mutation.
  assert.equal(b.messages, store.snapshot().messages, "messages array is cached");
  assert.equal(b.toolCards, store.snapshot().toolCards, "toolCards array is cached");
  // And they're not the same as the pre-mutation ones.
  assert.notEqual(a.messages, b.messages);
});

/* -------------------------------------------------------------------------- */
/*  Rendering-layer streaming methods                                         */
/*                                                                            */
/*  These tests cover the new event family used by the rendering layer:       */
/*    appendAssistantDelta, completeAssistant, appendReasoningDelta,           */
/*    completeReasoning. The legacy stream methods remain so the existing     */
/*    post-engine-run path stays backward compatible.                          */
/* -------------------------------------------------------------------------- */

test("session-store: appendAssistantDelta opens a fresh buffer on first call", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const msg = store.appendAssistantDelta("Hello");
  assert.equal(msg.kind, "assistant");
  assert.equal(msg.text, "Hello");
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1);
});

test("session-store: appendAssistantDelta extends the same buffer across calls", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistantDelta("foo ");
  store.appendAssistantDelta("bar");
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 1, "consecutive deltas should collapse into one message");
  assert.equal(assistants[0]?.text, "foo bar");
});

test("session-store: completeAssistant allows the next delta to open a new buffer", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistantDelta("first");
  store.completeAssistant();
  store.appendAssistantDelta("second");
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 2, "completeAssistant should reset the buffer");
  assert.equal(assistants[0]?.text, "first");
  assert.equal(assistants[1]?.text, "second");
});

test("session-store: completeAssistant is a no-op when no buffer is open", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const before = store.snapshot();
  store.completeAssistant();
  // No notification was emitted; snapshot reference is unchanged.
  assert.equal(store.snapshot(), before);
});

test("session-store: appendReasoningDelta accumulates into the reasoning buffer", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistantDelta("answer");
  store.appendReasoningDelta("think ");
  store.appendReasoningDelta("more");
  // Reasoning stays in the buffer — not visible in messages yet.
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants[0]?.reasoning, undefined, "reasoning is hidden until completeReasoning");
});

test("session-store: completeReasoning folds the buffer onto the streaming message", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistantDelta("answer");
  store.appendReasoningDelta("I thought about it");
  store.completeReasoning();
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants[0]?.reasoning, "I thought about it",
    "reasoning should be folded onto the streaming message");
  assert.equal(assistants[0]?.text, "answer",
    "chat text should be unchanged after folding reasoning");
});

test("session-store: completeReasoning folds onto the most recent assistant if no buffer is open", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistant("answer");
  store.appendReasoningDelta("a-posteriori reasoning");
  store.completeReasoning();
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants[0]?.reasoning, "a-posteriori reasoning");
});

test("session-store: completeReasoning with no reasoning buffer is a no-op", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistant("answer");
  const before = store.snapshot();
  store.completeReasoning();
  assert.equal(store.snapshot(), before, "no-op should not invalidate the snapshot");
});

test("session-store: completeReasoning drops reasoning when no assistant message exists", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendReasoningDelta("orphan reasoning");
  const before = store.snapshot();
  store.completeReasoning();
  // No assistant message to attach to — reasoning is dropped silently.
  // The snapshot reference stays stable because we never notify.
  assert.equal(store.snapshot(), before);
});

test("session-store: empty reasoning delta is a no-op", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistantDelta("answer");
  const before = store.snapshot();
  store.appendReasoningDelta("");
  assert.equal(store.snapshot(), before, "empty delta should not allocate a reasoning buffer");
});

test("session-store: appendAssistant + completeReasoning folds onto the new message", () => {
  // Backward-compat: the legacy post-engine-run `appendAssistant(...)` path
  // must still work, AND it should still pick up a reasoning buffer that
  // completed AFTER it was called. (Real engines emit in either order.)
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendReasoningDelta("thoughts");
  store.appendAssistant("answer");
  // Reasoning buffer still open — assistant was appended outside the
  // streaming path. Folding finds the most recent assistant.
  store.completeReasoning();
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants[0]?.reasoning, "thoughts");
  assert.equal(assistants[0]?.text, "answer");
});

test("session-store: appendAssistantDelta is idempotent against post-run appendAssistant", () => {
  // If the streaming path already pushed the assistant message, the
  // post-run `appendAssistant` would create a duplicate. This test
  // documents the current behavior (NOT idempotent — that's the
  // caller's responsibility via the streamedAssistantIds set in
  // engine-driver) so any future dedupe work has a clear baseline.
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.appendAssistantDelta("streamed");
  store.appendAssistant("streamed");
  const assistants = store.snapshot().messages.filter((m) => m.kind === "assistant");
  assert.equal(assistants.length, 2, "duplicate messages are NOT deduped at the store level");
});

/* -------------------------------------------------------------------------- */
/*  View-preference toggles                                                    */
/*                                                                            */
/*  The Pi-derived TUI features expose a `hideThinkingBlock` flag and a       */
/*  per-tool-card `expanded` flag on the store. The flag lives on the        */
/*  status object so consumers can read it off the snapshot without a       */
/*  separate getter, and the per-card flag is just the existing             */
/*  `TuiToolCard.collapsed` field with explicit `expand` / `collapse`        */
/*  helpers.                                                                 */
/* -------------------------------------------------------------------------- */

test("session-store: hideThinkingBlock defaults to true (Pi less-noisy baseline)", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  assert.equal(store.isThinkingHidden(), true, "default is hidden");
  assert.equal(store.snapshot().status.hideThinkingBlock, true, "snapshot mirrors the flag");
});

test("session-store: toggleThinkingBlock flips the flag and the snapshot", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const before = store.snapshot();
  store.toggleThinkingBlock();
  const after = store.snapshot();
  assert.equal(store.isThinkingHidden(), false, "first toggle reveals thinking");
  assert.equal(after.status.hideThinkingBlock, false, "snapshot reflects the new value");
  assert.notEqual(before, after, "toggle invalidates the snapshot");
  store.toggleThinkingBlock();
  assert.equal(store.isThinkingHidden(), true, "second toggle hides again");
  assert.equal(store.snapshot().status.hideThinkingBlock, true);
});

test("session-store: toggleThinkingBlock is a no-op when the snapshot is read before any toggle", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  // The default is "hidden"; calling toggle once should reveal.
  store.toggleThinkingBlock();
  assert.equal(store.snapshot().status.hideThinkingBlock, false);
  // And toggle again hides.
  store.toggleThinkingBlock();
  assert.equal(store.snapshot().status.hideThinkingBlock, true);
});

test("session-store: debug mode defaults to off and can be toggled", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  assert.equal(store.isDebugMode(), false);
  assert.equal(store.snapshot().status.debugMode, false);
  store.setDebugMode(true);
  assert.equal(store.isDebugMode(), true);
  assert.equal(store.snapshot().status.debugMode, true);
  store.toggleDebugMode();
  assert.equal(store.isDebugMode(), false);
  assert.equal(store.snapshot().status.debugMode, false);
});

test("session-store: toolCardsDefaultExpanded defaults to false (Pi default)", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  assert.equal(store.isToolCardsDefaultExpanded(), false);
});

test("session-store: toggleToolCardsDefaultExpanded flips the preference", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.toggleToolCardsDefaultExpanded(true);
  assert.equal(store.isToolCardsDefaultExpanded(), true);
  store.toggleToolCardsDefaultExpanded(false);
  assert.equal(store.isToolCardsDefaultExpanded(), false);
});

test("session-store: beginToolCard honors toolCardsDefaultExpanded=false", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.toggleToolCardsDefaultExpanded(false);
  const card = store.beginToolCard({ callId: "c1", name: "read_file", args: {} });
  assert.equal(card.collapsed, true, "default-collapsed is honored when pref is false");
});

test("session-store: beginToolCard honors toolCardsDefaultExpanded=true", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  store.toggleToolCardsDefaultExpanded(true);
  const card = store.beginToolCard({ callId: "c1", name: "read_file", args: {} });
  assert.equal(card.collapsed, false, "default-expanded is honored when pref is true");
});

test("session-store: expandToolCard flips collapsed to false", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const card = store.beginToolCard({ callId: "c1", name: "read_file", args: {} });
  assert.equal(card.collapsed, true);
  store.expandToolCard(card.id);
  const after = store.snapshot().toolCards.find((c) => c.id === card.id);
  assert.equal(after?.collapsed, false);
});

test("session-store: expandToolCard is a no-op when already expanded", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const card = store.beginToolCard({ callId: "c1", name: "read_file", args: {} });
  store.expandToolCard(card.id);
  const before = store.snapshot();
  store.expandToolCard(card.id);
  // Idempotent — the snapshot reference is preserved.
  assert.equal(store.snapshot(), before, "no-op should not invalidate the snapshot");
});

test("session-store: collapseToolCard flips collapsed to true", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const card = store.beginToolCard({ callId: "c1", name: "read_file", args: {} });
  store.expandToolCard(card.id);
  store.collapseToolCard(card.id);
  const after = store.snapshot().toolCards.find((c) => c.id === card.id);
  assert.equal(after?.collapsed, true);
});

test("session-store: expand / collapse on a missing card is a no-op", () => {
  const store = createSessionStore({ model: "MiniMax-M3", provider: "minimax" });
  const before = store.snapshot();
  store.expandToolCard("nonexistent");
  store.collapseToolCard("nonexistent");
  assert.equal(store.snapshot(), before, "missing-card calls must not invalidate the snapshot");
});
