import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionMetricsSummary } from "../../src/runtime/session-metrics.js";

test("buildSessionMetricsSummary reports infra_failed when transport retries are exhausted", () => {
  const summary = buildSessionMetricsSummary({
    toolResults: [],
    completionGateAttempts: 0,
    taskCompleted: false,
    verifiedCompletion: false,
    gateExhausted: true,
    stopReasonOverride: "infra_failed",
  });
  assert.equal(summary.stop_reason, "infra_failed");
  assert.equal(summary.completion_gate_attempts, 0);
  assert.equal(summary.verified_completion, false);
});

test("buildSessionMetricsSummary still reports gate_exhausted for normal completion-gate exhaustion", () => {
  const summary = buildSessionMetricsSummary({
    toolResults: [],
    completionGateAttempts: 3,
    taskCompleted: false,
    verifiedCompletion: false,
    gateExhausted: true,
  });
  assert.equal(summary.stop_reason, "gate_exhausted");
});

test("buildSessionMetricsSummary reports error for low-confidence clarification terminal state", () => {
  const summary = buildSessionMetricsSummary({
    toolResults: [],
    completionGateAttempts: 0,
    taskCompleted: false,
    verifiedCompletion: false,
    gateExhausted: true,
    stopReasonOverride: "error",
  });
  assert.equal(summary.stop_reason, "error");
});

test("natural stop without explicit verification is not solved", () => {
  const summary = buildSessionMetricsSummary({
    toolResults: [],
    completionGateAttempts: 0,
    taskCompleted: true,
    verifiedCompletion: false,
  });
  assert.equal(summary.verified_completion, false);
  assert.equal(summary.stop_reason, "error");
});

test("verified completion reports solved only when verification is true", () => {
  const summary = buildSessionMetricsSummary({
    toolResults: [],
    completionGateAttempts: 0,
    taskCompleted: true,
    verifiedCompletion: true,
  });
  assert.equal(summary.verified_completion, true);
  assert.equal(summary.stop_reason, "solved");
});
