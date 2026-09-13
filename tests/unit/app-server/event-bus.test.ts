/**
 * The replay log is bounded by bytes, not only by count.
 *
 * It was bounded by count alone — 2,000 events — which is not a bound on memory
 * when the events are not the same size, and they are not: `command.output.delta`
 * carries whatever chunk the child process emitted. Measured, 2,000 such deltas
 * at a realistic 40KB each is 76MB retained for a *single* thread, and every
 * thread the UI opens keeps its own bus for the life of the process.
 *
 * A long session then drove the app-server past 1.6GB into the 2GB V8 heap
 * limit, and the process was killed. From the browser that looked like a turn
 * which stopped producing output and never finished — no error, no crash
 * message, just silence. These tests pin the ceiling so it cannot come back.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ThreadEventBus } from "../../../src/app-server/event-bus.js";

/** A runtime event carries its own timestamp; the bus records the arrival time. */
const withTs = <T extends { type: string }>(event: T): T & { timestamp: string } => ({
  ...event,
  timestamp: new Date().toISOString(),
});

const CHUNK = 40_000;

test("a flood of large events stays within the byte ceiling", () => {
  const bus = new ThreadEventBus("t");
  const ceiling = 8 * 1024 * 1024;

  for (let i = 0; i < 2_000; i += 1) {
    bus.publish(withTs({ type: "command.output.delta", toolCallId: "t1", stream: "stdout", text: "x".repeat(CHUNK) }));
  }

  assert.ok(
    bus.retainedEventBytes <= ceiling,
    `retained ${bus.retainedEventBytes} bytes; 2,000 events at ${CHUNK} bytes would be ${2_000 * CHUNK} unbounded`,
  );
  // The point of the bound: the log holds a window, not the whole session.
  assert.ok(
    bus.replayAfter(0).events.length < 2_000,
    "every event was retained, so the byte ceiling had no effect",
  );
});

test("the newest event always survives eviction", () => {
  const bus = new ThreadEventBus("t");
  for (let i = 0; i < 500; i += 1) {
    bus.publish(withTs({ type: "command.output.delta", toolCallId: "t1", stream: "stdout", text: "y".repeat(CHUNK) }));
  }
  const replay = bus.replayAfter(0);
  assert.equal(
    replay.events.at(-1)?.sequence,
    500,
    "the last published event was evicted, so a replaying client would see a stale tail",
  );
  assert.equal(replay.latestSequence, 500);
});

test("a client resuming from an evicted point is told it missed history", () => {
  const bus = new ThreadEventBus("t");
  for (let i = 0; i < 500; i += 1) {
    bus.publish(withTs({ type: "command.output.delta", toolCallId: "t1", stream: "stdout", text: "z".repeat(CHUNK) }));
  }

  /*
   * The two cases are different and both matter. Replaying from 0 is a fresh
   * client being handed the window it is entitled to; replaying from a sequence
   * that no longer exists means a client believes it is caught up and is not,
   * and it has to be told.
   */
  assert.equal(bus.replayAfter(0).truncated, false, "a fresh client is not missing anything it was promised");
  assert.equal(bus.replayAfter(1).truncated, true, "an evicted resume point must report truncation");
});

test("the count bound still holds for small events", () => {
  // The byte ceiling must not be the only thing working: a thousand tiny events
  // are within budget but still past a two-hundred-event window.
  const bus = new ThreadEventBus("t", 200);
  for (let i = 0; i < 1_000; i += 1) {
    bus.publish(withTs({ type: "assistant.message.delta", text: "hi" }));
  }
  assert.equal(bus.replayAfter(0).events.length, 200, "the count bound stopped applying");
});

test("an event larger than the whole budget is still retained", () => {
  /*
   * A single 10MB delta cannot fit a 8MB ceiling. Dropping it would leave a
   * client with no record that the tool produced anything at all, which is
   * worse than holding one oversized event; the loop keeps the newest record
   * unconditionally and evicts everything else.
   */
  const bus = new ThreadEventBus("t");
  bus.publish(withTs({ type: "command.output.delta", toolCallId: "t1", stream: "stdout", text: "a".repeat(1_000) }));
  bus.publish(withTs({ type: "command.output.delta", toolCallId: "t1", stream: "stdout", text: "b".repeat(10 * 1024 * 1024) }));

  const replay = bus.replayAfter(0);
  assert.equal(replay.events.length, 1, "everything but the oversized event should have been evicted");
  assert.equal(replay.events.at(-1)?.sequence, 2, "the oversized event itself must survive");
});

test("a subscriber sees every event even when the log evicts it", () => {
  // Trimming the replay log must not trim the live stream: a connected client
  // still needs each delta as it happens, however old the log is.
  const bus = new ThreadEventBus("t", 10);
  const seen: number[] = [];
  bus.subscribe("s1", (record) => {
    seen.push(record.sequence);
  });

  for (let i = 0; i < 50; i += 1) bus.publish(withTs({ type: "assistant.message.delta", text: "x" }));

  assert.equal(seen.length, 50, "subscribers stopped receiving events once the log began evicting");
  assert.equal(bus.replayAfter(0).events.length, 10);
});
