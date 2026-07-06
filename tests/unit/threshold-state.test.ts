import test from "node:test";
import assert from "node:assert/strict";

import { calculateContextWarningState } from "../../src/context/threshold-state.js";

test("context state is ok below 70% utilization", () => {
  const state = calculateContextWarningState({ used: 100_000, softCap: 270_000 });
  assert.equal(state.state, "ok");
  assert.equal(state.ratio < 0.7, true);
});

test("context state is warning at 70% utilization", () => {
  const state = calculateContextWarningState({ used: 200_000, softCap: 270_000 });
  assert.equal(state.state, "warning");
});

test("context state is error at 85% utilization", () => {
  const state = calculateContextWarningState({ used: 240_000, softCap: 270_000 });
  assert.equal(state.state, "error");
});

test("context state is blocking at 95% utilization", () => {
  const state = calculateContextWarningState({ used: 270_000, softCap: 270_000 });
  assert.equal(state.state, "blocking");
  assert.equal(state.remaining, 0);
});

test("context state handles softCap=0 without divide-by-zero", () => {
  const state = calculateContextWarningState({ used: 1000, softCap: 0 });
  assert.equal(state.ratio, 0);
  assert.equal(state.state, "ok");
});