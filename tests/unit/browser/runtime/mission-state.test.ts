import { test } from "node:test";
import assert from "node:assert/strict";

import { MissionState } from "../../../../src/browser/runtime/mission-state.js";

test("a fact carries the evidence that produced it", () => {
  /*
   * A fact with no evidence is a guess, and a mission that reports a guess looks
   * the same as one that did the work. The evidence field is what makes the
   * difference checkable rather than trusted.
   */
  const state = new MissionState();
  state.recordFact("playwright_version", "1.63.0", "a12");
  assert.equal(state.get("playwright_version"), "1.63.0");
  assert.match(state.render(), /\[a12\]/);
});

test("ready() is a fold over the dependency edges, not a model decision", () => {
  const state = new MissionState();
  state.declareSubtask("research");
  state.declareSubtask("parabank", ["research"]);
  state.declareSubtask("invoice", ["parabank"]);
  assert.deepEqual(state.ready().map((subtask) => subtask.title), ["research"]);
  state.setSubtask("research", "verified");
  assert.deepEqual(state.ready().map((subtask) => subtask.title), ["parabank"]);
  state.setSubtask("parabank", "verified");
  assert.deepEqual(state.ready().map((subtask) => subtask.title), ["invoice"]);
});

test("a blocked subtask becomes ready when its dependency is verified", () => {
  const state = new MissionState();
  state.declareSubtask("a");
  state.declareSubtask("b", ["a"]);
  state.setSubtask("b", "blocked", "waiting on a");
  /*
   * `a` is ready and `b` is not, which is the assertion that matters. Testing
   * "nothing is ready" would be testing that a dependency-free subtask is
   * withheld, which is the opposite of the behaviour.
   */
  assert.deepEqual(state.ready().map((subtask) => subtask.title), ["a"]);
  state.setSubtask("a", "verified");
  assert.deepEqual(state.ready().map((subtask) => subtask.title), ["b"]);
});

test("done and verified are different claims", () => {
  /*
   * The distinction the verifier depends on. A model that believes it finished a
   * step sets `done`; only the runtime sets `verified`, and a dependency on a
   * merely `done` subtask is not satisfied.
   */
  const state = new MissionState();
  state.declareSubtask("a");
  state.declareSubtask("b", ["a"]);
  state.setSubtask("a", "done");
  assert.equal(state.ready().length, 0);
  state.setSubtask("a", "verified");
  assert.equal(state.ready().length, 1);
});

test("declaring a subtask twice keeps its dependencies and does not duplicate it", () => {
  const state = new MissionState();
  state.declareSubtask("a");
  state.declareSubtask("b", ["a"]);
  state.declareSubtask("b");
  assert.equal(state.subtasks.length, 2);
  assert.deepEqual(state.subtasks[1]?.requires, ["a"]);
});

test("state survives a round trip through JSON, which is what a restart does", () => {
  const state = new MissionState();
  state.goal = "do the thing";
  state.recordFact("v", "1.63.0", "a1");
  state.recordDerived("run_code", "PW-1.63.0-2015", "v, year");
  state.declareSubtask("research");
  state.setSubtask("research", "verified");
  state.pages.set("parabank", "p5");
  state.artifacts.set("invoice", { name: "invoice.txt", path: "/w/invoice.txt", bytes: 66, status: "saved" });
  state.recordFailure("a91", "FORM_VALIDATION");

  const restored = MissionState.from(state.toJSON());
  assert.equal(restored.goal, "do the thing");
  assert.equal(restored.get("v"), "1.63.0");
  assert.equal(restored.get("run_code"), "PW-1.63.0-2015");
  assert.equal(restored.subtasks[0]?.status, "verified");
  assert.equal(restored.artifacts.get("invoice")?.bytes, 66);
  assert.equal(restored.failures.length, 1);
});

test("an empty state renders nothing, so a fresh mission pays no tokens for it", () => {
  assert.equal(new MissionState().render(), "");
});
