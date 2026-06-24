import test from "node:test";
import assert from "node:assert/strict";
import { QueryGuard, ReentrantQueryError } from "../../src/runtime/query-guard.js";

test("QueryGuard allows first query", () => {
  const guard = new QueryGuard();
  const gen = guard.start();
  assert.ok(gen > 0);
  assert.equal(guard.getState(), "dispatching");
  guard.markRunning(gen);
  assert.equal(guard.getState(), "running");
  guard.finish(gen);
  assert.equal(guard.getState(), "idle");
});

test("QueryGuard rejects re-entrant query", () => {
  const guard = new QueryGuard();
  const gen = guard.start();
  guard.markRunning(gen);
  assert.throws(() => guard.start(), ReentrantQueryError);
  guard.finish(gen);
  assert.equal(guard.getState(), "idle");
});

test("QueryGuard stale finish is ignored", () => {
  const guard = new QueryGuard();
  const gen1 = guard.start();
  guard.markRunning(gen1);
  guard.finish(gen1);
  assert.equal(guard.getState(), "idle");

  const gen2 = guard.start();
  // Trying to finish with old generation should be ignored
  const result = guard.finish(gen1);
  assert.equal(result, false);
  assert.equal(guard.getState(), "dispatching");
  guard.finish(gen2);
  assert.equal(guard.getState(), "idle");
});

test("QueryGuard reset forces idle", () => {
  const guard = new QueryGuard();
  const gen = guard.start();
  guard.markRunning(gen);
  guard.reset();
  assert.equal(guard.getState(), "idle");
});
