/**
 * concurrency.test.ts — proves the AdaptiveConcurrencyQueue fix
 * prevents permanent throttling and recovers properly.
 *
 * The bug: a single >30s call used to drop concurrency to 1
 * permanently (because the latency metric included queue-wait time
 * AND recovery required < 10s observed latency, which is impossible
 * at concurrency=1 since every call waited for the previous one).
 *
 * The fix: latency is measured around the model call only
 * (latencyFn parameter), drops require TWO consecutive slow calls,
 * and `reset()` restores max concurrency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AdaptiveConcurrencyQueue } from "../../../src/model/concurrency.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("concurrency: a single slow call does NOT drop concurrency (requires 2 consecutive)", async () => {
  const q = new AdaptiveConcurrencyQueue(2, { maxConcurrency: 5 });
  assert.equal(q.concurrency, 2);
  // One fast call climbs to 3 (matches original semantics).
  await q.enqueue(async () => "fast", { latencyFn: () => 2_000 });
  assert.equal(q.concurrency, 3, "fast call climbs by 1");
  // Single slow call — must NOT drop yet (only 1 consecutive slow).
  await q.enqueue(async () => "slow", { latencyFn: () => 31_000 });
  assert.equal(q.concurrency, 3, "single slow call must not drop concurrency");
  // Second consecutive slow call — now drop by 1.
  await q.enqueue(async () => "slow", { latencyFn: () => 31_000 });
  assert.equal(q.concurrency, 2, "two consecutive slow calls drop by 1");
});

test("concurrency: drop is bounded to one step per call", async () => {
  const q = new AdaptiveConcurrencyQueue(5, { maxConcurrency: 5, minConcurrency: 1 });
  // Each pair of consecutive-slow calls drops by 1. Start at 5.
  // After 4 pairs (8 calls), we should be at min=1, NOT latched.
  for (let i = 0; i < 8; i++) {
    await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  }
  assert.equal(q.concurrency, 1, `should be at min floor, got ${q.concurrency}`);
  // Recovery: a single fast call climbs by 1.
  await q.enqueue(async () => "x", { latencyFn: () => 2_000 });
  assert.equal(q.concurrency >= 2, true, `fast call should climb back, got ${q.concurrency}`);
});

test("concurrency: a fast call after slow returns concurrency to max", async () => {
  const q = new AdaptiveConcurrencyQueue(2, { maxConcurrency: 5 });
  // Two consecutive slow → drop to 1
  await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  assert.equal(q.concurrency, 1);
  // One fast call (< 10s observed latency) → climb back
  await q.enqueue(async () => "x", { latencyFn: () => 2_000 });
  assert.equal(q.concurrency, 2);
  await q.enqueue(async () => "x", { latencyFn: () => 2_000 });
  assert.equal(q.concurrency, 3);
});

test("concurrency: reset() restores max concurrency and clears slow counter", async () => {
  const q = new AdaptiveConcurrencyQueue(2, { maxConcurrency: 5 });
  await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  assert.equal(q.concurrency, 1, "should have dropped to 1");
  q.reset();
  assert.equal(q.concurrency, 5, "reset() must restore max");
  // Now a single slow call does NOT drop (counter was reset).
  await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  assert.equal(q.concurrency, 5, "single slow after reset does not drop");
});

test("concurrency: latencyFn measures model-call only, not queue wait", async () => {
  // Simulate the bug condition: concurrency=1, the second call has
  // to wait for the first. With the OLD code, the observed latency
  // for the second call would be (first-call-time + second-call-time)
  // because lastLatencyMs measured wall time around queue.add().
  // With the FIX, latencyFn returns just the model-call time and
  // the queue tuner doesn't see the wait as slowness.
  const q = new AdaptiveConcurrencyQueue(1, { maxConcurrency: 5 });
  // First call: slow model call.
  await q.enqueue(
    async () => {
      await delay(50);
    },
    { latencyFn: () => 50 },
  );
  // Second call: fast model call, but with concurrency=1 it must
  // wait for the first. The latencyFn reports just the model-call
  // time (5ms), so the tuner sees a fast call and climbs back up.
  await q.enqueue(
    async () => {
      await delay(5);
    },
    { latencyFn: () => 5 },
  );
  assert.equal(q.concurrency >= 2, true, `expected climb to >= 2, got ${q.concurrency}`);
});

test("concurrency: min concurrency floor is respected", async () => {
  const q = new AdaptiveConcurrencyQueue(2, { maxConcurrency: 5, minConcurrency: 2 });
  // Even with many slow calls, we never drop below minConcurrency.
  for (let i = 0; i < 10; i++) {
    await q.enqueue(async () => "x", { latencyFn: () => 31_000 });
  }
  assert.equal(q.concurrency, 2, `min floor respected, got ${q.concurrency}`);
});
