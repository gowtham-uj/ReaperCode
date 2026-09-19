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

test("the rendered state does not grow with the size of the plan", () => {
  /*
   * The regression this pins, and it cost a real mission 2.29M tokens.
   *
   * `render()` said "bounded on purpose" in its comment while rendering every
   * subtask and every ready one. A mission declared fifteen subtasks on its
   * second turn, so `READY NOW` listed fourteen names, and the block grew from
   * 726 characters to 3,561 over the run.
   *
   * Size matters more here than anywhere else in the codebase, because this
   * block is re-sent with every later model call: a block that grows by 20
   * characters a turn is not 20 characters, it is 20 times the turns remaining,
   * and a mission has hundreds. Measured: 207KB of content became 9.16M
   * characters of context.
   *
   * So the assertion is about the *shape*, not a number: a hundred subtasks must
   * render no larger than ten do.
   */
  const small = new MissionState();
  for (let i = 0; i < 10; i++) small.declareSubtask(`task-${i}`);

  const large = new MissionState();
  for (let i = 0; i < 100; i++) large.declareSubtask(`task-${i}`);

  const smallText = small.render();
  const largeText = large.render();
  assert.ok(
    largeText.length <= smallText.length + 200,
    `ten times the plan must not be ten times the block: ${smallText.length} chars for 10, ${largeText.length} for 100`,
  );
  /*
   * And the count is what makes the cap honest. A capped list without a total
   * reads as the whole list, which is how a model concludes it has seen
   * everything.
   */
  assert.match(largeText, /\(of 100\)/, "the total must be stated, or the cap reads as the list");
  assert.match(largeText, /\+95 more/, "and the ready list must say how much it is not showing");
});

test("the state does not grow without bound as facts accumulate", () => {
  /*
   * The same rule for facts. A mission reads values for an hour, and the block
   * is re-sent every turn, so an unbounded fact list is the same arithmetic.
   */
  const state = new MissionState();
  for (let i = 0; i < 60; i++) state.recordFact(`fact-${i}`, String(i), `a${i}`);
  const text = state.render();
  assert.match(text, /last \d+ of 60/, "the cap must be visible as a cap");
  assert.ok(text.length < 1_500, `the fact list must stay bounded, got ${text.length} chars`);
});
