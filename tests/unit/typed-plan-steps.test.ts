import test from "node:test";
import assert from "node:assert/strict";

import {
  advancePlanStep,
  createPlanState,
  createPlanSteps,
  planProgress,
  renderPlanForCockpit,
  setPlanSteps,
} from "../../src/runtime/plan-state.js";

test("createPlanSteps dedupes by id and sets default status pending", () => {
  const steps = createPlanSteps([
    { id: "a", title: "first" },
    { id: "a", title: "first-updated" },
    { id: "b", title: "second", status: "in_progress" },
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.status, "pending");
  assert.equal(steps[1]?.status, "in_progress");
});

test("setPlanSteps replaces the plan's typed steps", () => {
  let state = createPlanState();
  state = setPlanSteps(state, [
    { id: "x", title: "fix the bug", status: "in_progress" },
    { id: "y", title: "add a test", status: "pending" },
  ]);
  assert.equal(state.steps?.length, 2);
  state = setPlanSteps(state, [{ id: "z", title: "ship it" }]);
  assert.equal(state.steps?.length, 1);
  assert.equal(state.steps?.[0]?.id, "z");
});

test("advancePlanStep moves a step forward and attaches evidence", () => {
  let state = createPlanState();
  state = setPlanSteps(state, [
    { id: "a", title: "first" },
    { id: "b", title: "second" },
  ]);
  state = advancePlanStep(state, "a", { status: "in_progress" });
  state = advancePlanStep(state, "a", { status: "completed", evidence: "tests pass" });
  assert.equal(state.steps?.[0]?.status, "completed");
  assert.equal(state.steps?.[0]?.evidence, "tests pass");
  assert.equal(state.steps?.[1]?.status, "pending");
});

test("planProgress computes counts and isComplete", () => {
  let state = createPlanState();
  state = setPlanSteps(state, [
    { id: "a", title: "first", status: "completed" },
    { id: "b", title: "second", status: "in_progress" },
    { id: "c", title: "third", status: "pending" },
    { id: "d", title: "fourth", status: "blocked" },
  ]);
  const progress = planProgress(state);
  assert.ok(progress);
  assert.equal(progress?.total, 4);
  assert.equal(progress?.completed, 1);
  assert.equal(progress?.inProgress, 1);
  assert.equal(progress?.blocked, 1);
  assert.equal(progress?.pending, 1);
  assert.equal(progress?.isComplete, false);
  assert.equal(progress?.ratio, 0.25);
});

test("planProgress returns undefined for plans with no typed steps", () => {
  const state = createPlanState();
  assert.equal(planProgress(state), undefined);
});

test("renderPlanForCockpit renders typed steps with status and progress", () => {
  let state = createPlanState();
  state = setPlanSteps(state, [
    { id: "a", title: "inspect", status: "completed", evidence: "tests pass" },
    { id: "b", title: "patch", status: "in_progress", detail: "src/index.ts" },
    { id: "c", title: "verify", status: "pending", acceptanceCriteria: "npm test" },
  ]);
  const rendered = renderPlanForCockpit(state);
  assert.match(rendered, /### Plan Steps/);
  assert.match(rendered, /\[x\] a: inspect.*tests pass/);
  assert.match(rendered, /\[>\] b: patch.*src\/index\.ts/);
  assert.match(rendered, /\[ \] c: verify.*acceptance: npm test/);
  assert.match(rendered, /### Progress: 1\/3 \(33%\)/);
});
