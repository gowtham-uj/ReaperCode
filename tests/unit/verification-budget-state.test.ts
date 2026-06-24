import test from "node:test";
import assert from "node:assert/strict";

import {
  addCompletionEvidence,
  createVerificationState,
  deriveMissingEvidence,
  recordVerificationCheck,
  renderVerificationStateForCockpit,
  VerificationStateSchema,
} from "../../src/runtime/verification-state.js";
import { createBudgetState, recordBudgetUsage, renderBudgetStateForCockpit } from "../../src/runtime/budget-state.js";
import { parseRuntimeState } from "../../src/runtime/state.js";

function createRuntimeState() {
  return {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    noticeVerbosity: "normal",
    sessionProtocolVersion: 1,
    userIntentSummary: "Add verification and budget state primitives",
    tokenBudget: {
      softCap: 200000,
      inputTokens: 0,
      outputTokens: 0,
    },
    epicState: {
      objectives: [],
    },
    feedback: [],
    negativeConstraints: [],
  };
}

test("runtime state keeps verification and budget state optional", () => {
  const state = parseRuntimeState(createRuntimeState());

  assert.equal(state.verificationState, undefined);
  assert.equal(state.budgetState, undefined);
});

test("runtime state parses optional verification and budget state", () => {
  const verificationState = createVerificationState(["npm test"]);
  const budgetState = createBudgetState({ maxTurns: 5, maxToolCalls: 10, maxModelCalls: 3 });
  const state = parseRuntimeState({
    ...createRuntimeState(),
    verificationState,
    budgetState,
  });

  assert.deepEqual(state.verificationState?.requiredChecks, ["npm test"]);
  assert.equal(state.budgetState?.maxToolCalls, 10);
});

test("verification schema rejects unknown fields", () => {
  assert.throws(
    () =>
      VerificationStateSchema.parse({
        ...createVerificationState(),
        extra: true,
      }),
    /Unrecognized key/,
  );
});

test("records passed, failed, and skipped verification checks without mutating input", () => {
  const initial = createVerificationState(["npm test", "npm run typecheck", "git diff --check"]);
  const afterPassed = recordVerificationCheck(initial, {
    command: "npm test",
    status: "passed",
    evidence: "12 unit tests passed",
    verifiedAt: "2026-06-24T03:40:00.000Z",
  });
  const afterFailed = recordVerificationCheck(afterPassed, {
    command: "npm run typecheck",
    status: "failed",
    evidence: "Known RuntimeEngineInput.hooks baseline error",
  });
  const afterSkipped = recordVerificationCheck(afterFailed, {
    command: "git diff --check",
    status: "skipped",
    evidence: "Deferred while editing",
  });

  assert.deepEqual(initial.completedChecks, []);
  assert.equal(afterSkipped.completedChecks.length, 3);
  assert.equal(afterSkipped.completedChecks[0]?.status, "passed");
  assert.equal(afterSkipped.completedChecks[1]?.status, "failed");
  assert.equal(afterSkipped.completedChecks[2]?.status, "skipped");
  assert.equal(afterPassed.lastVerificationAt, "2026-06-24T03:40:00.000Z");
  assert.deepEqual(afterSkipped.completionEvidence, ["12 unit tests passed"]);
  assert.deepEqual(afterSkipped.missingEvidence, ["npm run typecheck", "git diff --check"]);
});

test("derives missing evidence from required checks, passed checks, and explicit evidence", () => {
  const initial = createVerificationState(["npm test", "manual review"]);
  const afterCheck = recordVerificationCheck(initial, {
    command: "npm test",
    status: "passed",
    evidence: "npm test passed",
  });
  const afterEvidence = addCompletionEvidence(afterCheck, "manual review");

  assert.deepEqual(deriveMissingEvidence(initial), ["npm test", "manual review"]);
  assert.deepEqual(afterCheck.missingEvidence, ["manual review"]);
  assert.deepEqual(afterEvidence.missingEvidence, []);
  assert.deepEqual(afterEvidence.completionEvidence, ["npm test passed", "manual review"]);
});

test("renders verification state for cockpit", () => {
  const state = recordVerificationCheck(createVerificationState(["npm test"]), {
    command: "npm test",
    status: "passed",
    evidence: "tests passed",
    verifiedAt: "2026-06-24T03:41:00.000Z",
  });
  const rendered = renderVerificationStateForCockpit(state);

  assert.match(rendered, /# Verification State/);
  assert.match(rendered, /Required checks: npm test/);
  assert.match(rendered, /Completed checks: npm test \[passed\] - tests passed/);
  assert.match(rendered, /Last verification: 2026-06-24T03:41:00\.000Z/);
  assert.match(rendered, /Missing evidence: none/);
});

test("budget state records usage and warns near or over configured caps", () => {
  const initial = createBudgetState({ maxTurns: 10, maxToolCalls: 5, maxModelCalls: 2 });
  const nearCap = recordBudgetUsage(initial, { turns: 8, toolCalls: 3, modelCalls: 1 });
  const overCap = recordBudgetUsage(nearCap, { toolCalls: 3, modelCalls: 2 });

  assert.equal(initial.turnsUsed, 0);
  assert.equal(nearCap.turnsUsed, 8);
  assert.equal(nearCap.toolCallsUsed, 3);
  assert.deepEqual(nearCap.warnings, ["Turns used 8/10 is near the configured limit."]);
  assert.equal(overCap.toolCallsUsed, 6);
  assert.equal(overCap.modelCallsUsed, 3);
  assert.ok(overCap.warnings.includes("Tool calls used 6/5 exceeds the configured limit."));
  assert.ok(overCap.warnings.includes("Model calls used 3/2 exceeds the configured limit."));
});

test("budget state rejects negative usage increments", () => {
  const state = createBudgetState();

  assert.throws(() => recordBudgetUsage(state, { toolCalls: -1 }), /non-negative integer/);
});

test("renders budget state for cockpit", () => {
  const state = recordBudgetUsage(createBudgetState({ maxTurns: 1, maxToolCalls: 10 }), { turns: 1, toolCalls: 2 });
  const rendered = renderBudgetStateForCockpit(state);

  assert.match(rendered, /# Budget State/);
  assert.match(rendered, /Turns: 1 \/ 1/);
  assert.match(rendered, /Tool calls: 2 \/ 10/);
  assert.match(rendered, /Model calls: 0 \/ unlimited/);
  assert.match(rendered, /Warnings: Turns used 1\/1 is near the configured limit\./);
});
