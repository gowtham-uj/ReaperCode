/**
 * session-isolation.test.ts — proves that every Reaper session is
 * strictly independent: each SessionStore carries its own sessionId,
 * its own message buffer, its own status, and its own startedAt
 * timestamp. Two stores created back-to-back must not share any
 * mutable state.
 *
 * Why this test exists: the user reported that conversations from
 * different TUI invocations were bleeding into each other. The fix
 * is to derive sessionId from `crypto.randomUUID()` so collisions
 * are physically impossible, and to confirm that the SessionStore's
 * mutation API never reaches across instances.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionStore } from "../../../src/tui/state/session-store.js";

test("session-isolation: two stores created back-to-back have distinct sessionIds", () => {
  const a = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const b = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const aId = a.getStatus().sessionId;
  const bId = b.getStatus().sessionId;
  assert.notEqual(aId, bId, "two freshly-built stores must have different sessionIds");
  assert.match(aId, /^ses_[a-f0-9]{16}$/, "sessionId must be UUID-derived (16 hex chars)");
  assert.match(bId, /^ses_[a-f0-9]{16}$/);
});

test("session-isolation: 50 stores produce 50 unique sessionIds", () => {
  const stores = Array.from({ length: 50 }, () =>
    createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" }),
  );
  const ids = new Set(stores.map((s) => s.getStatus().sessionId));
  assert.equal(ids.size, 50, "all 50 stores must have unique sessionIds");
});

test("session-isolation: messages appended to store A never appear in store B", () => {
  const a = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const b = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });

  a.appendUser("hello from A");
  a.appendAssistant("hi A");
  b.appendUser("hello from B");

  const aMsgs = a.snapshot().messages.filter((m) => m.kind === "user");
  const bMsgs = b.snapshot().messages.filter((m) => m.kind === "user");

  assert.equal(aMsgs.length, 1);
  assert.equal(bMsgs.length, 1);
  assert.equal(aMsgs[0]?.kind === "user" ? aMsgs[0].text : "", "hello from A");
  assert.equal(bMsgs[0]?.kind === "user" ? bMsgs[0].text : "", "hello from B");
  // B must not see A's assistant reply.
  const bAssistantCount = b.snapshot().messages.filter((m) => m.kind === "assistant").length;
  assert.equal(bAssistantCount, 0, "store B must not see store A's assistant messages");
});

test("session-isolation: promptCount + messageCount + firstPrompt are per-store", () => {
  const a = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const b = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });

  // The createSessionStore call already appends one system message
  // ("Reaper TUI ready..."). That counts toward messageCount but
  // not toward promptCount.
  const baselineMsgs = 1;
  const baselinePrompts = 0;

  a.appendUser("first A prompt");
  a.appendAssistant("first A reply");
  a.appendUser("second A prompt");

  assert.equal(a.promptCount(), baselinePrompts + 2);
  assert.equal(a.messageCount(), baselineMsgs + 3);
  assert.equal(a.firstPrompt(), "first A prompt");

  assert.equal(b.promptCount(), baselinePrompts);
  assert.equal(b.messageCount(), baselineMsgs);
  assert.equal(b.firstPrompt(), undefined);
});

test("session-isolation: startedAt is recent and ISO-8601", () => {
  // Two stores created within the same millisecond may legitimately
  // share an ISO timestamp — the unique discriminator is the
  // sessionId, not the timestamp. We still assert both fall inside
  // the test's wall-clock window.
  const before = Date.now() - 1; // 1ms slack for clock granularity
  const a = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const b = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const after = Date.now() + 1;

  for (const iso of [a.startedAtIso(), b.startedAtIso()]) {
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be ISO-8601 ms precision");
    const ms = Date.parse(iso);
    assert.ok(ms >= before && ms <= after, `startedAt ${iso} within [${before}, ${after}]`);
  }
});

test("session-isolation: setStatus on store A does not affect store B's status", () => {
  const a = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const b = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });

  a.setPhase("streaming");
  a.setStatus({ tokens: 12345, ctxPct: 42 });

  assert.equal(a.getStatus().phase, "streaming");
  assert.equal(b.getStatus().phase, "idle", "store B phase must stay idle");
  assert.equal(a.getStatus().tokens, 12345);
  assert.equal(b.getStatus().tokens, 0, "store B tokens must stay 0");
});

test("session-isolation: snapshot is independent (mutating A invalidates A's snapshot, not B's)", () => {
  const a = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const b = createSessionStore({ model: "claude-opus-4-8", provider: "anthropic" });
  const aSnap1 = a.snapshot();
  const bSnap1 = b.snapshot();
  a.appendUser("trigger A mutation");
  const aSnap2 = a.snapshot();
  const bSnap2 = b.snapshot();
  assert.notEqual(aSnap1, aSnap2, "store A's snapshot must change after a mutation");
  assert.equal(bSnap1, bSnap2, "store B's snapshot reference must be unchanged");
});

test("session-isolation: explicit sessionId is preserved", () => {
  const explicit = "ses_resume_abc12345";
  const a = createSessionStore({
    model: "claude-opus-4-8",
    provider: "anthropic",
    sessionId: explicit,
  });
  assert.equal(a.getStatus().sessionId, explicit, "explicit sessionId must be preserved");
});
