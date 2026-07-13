import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.mjs";

function event(eventId, occurredAt, payload = {}) {
  return { eventId, occurredAt, payload };
}

test("append validates event shape and deduplicates by eventId", () => {
  const store = new EventStore();

  assert.throws(() => store.append({ eventId: "", occurredAt: "2026-01-01T00:00:00.000Z" }), /eventId/i);
  assert.throws(() => store.append({ eventId: "evt-1", occurredAt: "not-a-date" }), /occurredAt/i);

  const first = store.append(event("evt-1", "2026-01-02T10:00:00.000Z", { amount: 10 }));
  const duplicate = store.append(event("evt-1", "2026-01-02T10:00:00.000Z", { amount: 99 }));

  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.deepEqual(store.snapshot().events, [event("evt-1", "2026-01-02T10:00:00.000Z", { amount: 10 })]);
});

test("listAfter is chronological, exclusive, and bounded", () => {
  const store = new EventStore();
  store.append(event("evt-3", "2026-01-03T10:00:00.000Z"));
  store.append(event("evt-1", "2026-01-01T10:00:00.000Z"));
  store.append(event("evt-2", "2026-01-02T10:00:00.000Z"));

  assert.deepEqual(
    store.listAfter("evt-1", 1).map((item) => item.eventId),
    ["evt-2"],
  );
  assert.deepEqual(
    store.listAfter(undefined, 10).map((item) => item.eventId),
    ["evt-1", "evt-2", "evt-3"],
  );
  assert.throws(() => store.listAfter("evt-1", 0), /limit/i);
  assert.throws(() => store.listAfter("missing", 1), /cursor/i);
});

test("snapshot is immutable and does not expose stored payload references", () => {
  const store = new EventStore();
  const original = event("evt-1", "2026-01-01T10:00:00.000Z", { labels: ["new"] });
  store.append(original);

  original.payload.labels.push("mutated-after-append");
  const snapshot = store.snapshot();
  snapshot.events[0].payload.labels.push("mutated-through-snapshot");

  assert.deepEqual(store.snapshot(), {
    eventCount: 1,
    events: [event("evt-1", "2026-01-01T10:00:00.000Z", { labels: ["new"] })],
  });
});
