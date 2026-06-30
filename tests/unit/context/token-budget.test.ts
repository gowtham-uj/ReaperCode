/**
 * Unit tests for the per-turn token budget tracker (Phase T2.7).
 *
 * Covers:
 *   - `beginTurn` resets the per-turn delta boundary.
 *   - `record` accumulates input + output + cache tokens across calls.
 *   - `snapshot` reports the per-turn delta AND the cumulative totals.
 *   - Undefined usage (provider didn't report) is a silent no-op.
 *   - Non-finite usage values are dropped, not NaN-poisoned.
 *   - `reset` clears both turn-boundary and cumulative totals.
 *   - `tokenUsageFromResponse` normalizes Anthropic and OpenAI shapes
 *     and returns undefined when neither shape is present.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TokenBudgetTracker,
  tokenUsageFromResponse,
} from "../../../src/context/token-budget.js";

test("record() accumulates input + output tokens", () => {
  const t = new TokenBudgetTracker();
  t.beginTurn();
  t.record({ inputTokens: 100, outputTokens: 50 });
  t.record({ inputTokens: 200, outputTokens: 80 });
  const snap = t.snapshot();
  assert.equal(snap.inputTokens, 300);
  assert.equal(snap.outputTokens, 130);
  assert.equal(snap.callCount, 2);
  assert.equal(snap.cumulativeInputTokens, 300);
  assert.equal(snap.cumulativeOutputTokens, 130);
  assert.equal(snap.cumulativeCallCount, 2);
});

test("snapshot reports per-turn delta, cumulative stays run-wide", () => {
  const t = new TokenBudgetTracker();
  t.beginTurn();
  t.record({ inputTokens: 100, outputTokens: 40 });
  t.record({ inputTokens: 50, outputTokens: 10 });
  const turn1 = t.snapshot();
  assert.equal(turn1.inputTokens, 150);
  assert.equal(turn1.cumulativeInputTokens, 150);

  t.beginTurn();
  t.record({ inputTokens: 300, outputTokens: 200 });
  const turn2 = t.snapshot();
  // Turn 2 delta is just the 300 input / 200 output of the new call.
  assert.equal(turn2.inputTokens, 300);
  assert.equal(turn2.outputTokens, 200);
  assert.equal(turn2.cumulativeInputTokens, 450);
  assert.equal(turn2.cumulativeOutputTokens, 250);
  assert.equal(turn2.callCount, 1);
});

test("record() with undefined usage is a silent no-op", () => {
  const t = new TokenBudgetTracker();
  t.beginTurn();
  t.record(undefined);
  t.record(null);
  const snap = t.snapshot();
  // undefined / null are silent skips — no calls recorded.
  assert.equal(snap.callCount, 0);
  assert.equal(snap.inputTokens, 0);
});

test("record() with all-zero usage still counts as a call", () => {
  // A provider that reports `usage: { input_tokens: 0, output_tokens: 0 }`
  // is still a real model call — the tracker increments callCount.
  // (This is the documented behavior; the previous test was updated
  // because the "third record" was a real call, not a no-op.)
  const t = new TokenBudgetTracker();
  t.beginTurn();
  t.record({ inputTokens: 0, outputTokens: 0 });
  const snap = t.snapshot();
  assert.equal(snap.callCount, 1);
  assert.equal(snap.inputTokens, 0);
  assert.equal(snap.outputTokens, 0);
});

test("non-finite usage values are dropped without poisoning totals", () => {
  const t = new TokenBudgetTracker();
  t.beginTurn();
  // NaN and +Inf are valid `number` values but aren't finite; the
  // tracker must drop them so the running totals stay arithmetic-clean.
  t.record({ inputTokens: Number.NaN, outputTokens: 10 });
  t.record({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 20 });
  t.record({ inputTokens: 50, outputTokens: 30 });
  const snap = t.snapshot();
  assert.equal(snap.inputTokens, 50);
  assert.equal(snap.outputTokens, 60);
});

test("cacheRead + cacheWrite accumulate separately from inputTokens", () => {
  const t = new TokenBudgetTracker();
  t.beginTurn();
  t.record({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5 });
  t.record({ inputTokens: 50, outputTokens: 10 });
  const snap = t.snapshot();
  // inputTokens is the input side; cacheRead is NOT added to input.
  assert.equal(snap.inputTokens, 150);
  assert.equal(snap.outputTokens, 30);
  assert.equal(snap.cacheReadTokens, 80);
  assert.equal(snap.cacheWriteTokens, 5);
});

test("reset() clears both turn-boundary and cumulative totals", () => {
  const t = new TokenBudgetTracker();
  t.beginTurn();
  t.record({ inputTokens: 500, outputTokens: 200 });
  t.reset();
  t.beginTurn();
  const snap = t.snapshot();
  assert.equal(snap.inputTokens, 0);
  assert.equal(snap.outputTokens, 0);
  assert.equal(snap.cumulativeInputTokens, 0);
  assert.equal(snap.callCount, 0);
});

test("snapshot takenAt is a valid ISO timestamp", () => {
  const t = new TokenBudgetTracker();
  const snap = t.snapshot();
  // Must round-trip through Date without throwing.
  const ms = Date.parse(snap.takenAt);
  assert.ok(Number.isFinite(ms), `takenAt is not a valid date: ${snap.takenAt}`);
});

test("tokenUsageFromResponse handles the Anthropic shape", () => {
  const usage = tokenUsageFromResponse({
    usage: { input_tokens: 200, output_tokens: 80 },
  });
  assert.deepEqual(usage, { inputTokens: 200, outputTokens: 80 });
});

test("tokenUsageFromResponse handles the Anthropic cache fields", () => {
  const usage = tokenUsageFromResponse({
    usage: {
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 25,
    },
  });
  assert.deepEqual(usage, {
    inputTokens: 200,
    outputTokens: 80,
    cacheReadTokens: 150,
    cacheWriteTokens: 25,
  });
});

test("tokenUsageFromResponse handles the OpenAI Chat shape", () => {
  // The helper ignores `total_tokens` (it varies in meaning across
  // providers); the test exercises just the two fields it consumes.
  const usage = tokenUsageFromResponse({
    usage: { prompt_tokens: 400, completion_tokens: 120 },
  });
  assert.deepEqual(usage, { inputTokens: 400, outputTokens: 120 });
});

test("tokenUsageFromResponse returns undefined when no usage envelope is present", () => {
  assert.equal(tokenUsageFromResponse(undefined), undefined);
  assert.equal(tokenUsageFromResponse(null), undefined);
  assert.equal(tokenUsageFromResponse({}), undefined);
  assert.equal(tokenUsageFromResponse({ usage: {} }), undefined);
  // total_tokens alone is not enough — providers vary in what it means.
  // Cast through unknown because our typed helper doesn't accept this
  // field by name; the cast exercises the runtime normalization.
  assert.equal(
    tokenUsageFromResponse({ usage: { total_tokens: 500 } } as unknown as Parameters<typeof tokenUsageFromResponse>[0]),
    undefined,
  );
});

test("tokenUsageFromResponse ignores unknown shape (not anthropic, not openai)", () => {
  // Some custom proxy might inject a future field — we only treat the
  // documented shapes as authoritative.
  assert.equal(
    tokenUsageFromResponse({ usage: { foo: 1, bar: 2 } } as unknown as Parameters<typeof tokenUsageFromResponse>[0]),
    undefined,
  );
});
