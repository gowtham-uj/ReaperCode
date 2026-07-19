import test from "node:test";
import assert from "node:assert/strict";

import { streamEventsEnabled } from "../../src/logging/stream-events.js";

test("streamEventsEnabled defaults to false", () => {
  delete process.env.REAPER_STREAM_EVENTS;
  assert.equal(streamEventsEnabled(), false);
});

test("streamEventsEnabled is true for =1", () => {
  process.env.REAPER_STREAM_EVENTS = "1";
  assert.equal(streamEventsEnabled(), true);
  delete process.env.REAPER_STREAM_EVENTS;
});

test("streamEventsEnabled is true for =true", () => {
  process.env.REAPER_STREAM_EVENTS = "true";
  assert.equal(streamEventsEnabled(), true);
  delete process.env.REAPER_STREAM_EVENTS;
});
