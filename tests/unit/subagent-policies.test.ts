import test from "node:test";
import assert from "node:assert/strict";

import {
  createVerificationState,
  applyReviewerVerdict,
  isReviewerBlocking,
  deriveMissingEvidence,
  recordVerificationCheck,
} from "../../src/runtime/verification-state.js";

test("initial reviewer verdict is undefined", () => {
  const state = createVerificationState(["npm test"]);
  assert.equal(state.reviewerVerdict, undefined);
  assert.equal(isReviewerBlocking(state), false);
  assert.deepEqual(state.missingEvidence, ["npm test"]);
});

test("approved reviewer verdict does not add missing evidence", () => {
  let state = createVerificationState(["npm test"]);
  state = applyReviewerVerdict(state, "approved", "LGTM");
  assert.equal(isReviewerBlocking(state), false);
  assert.deepEqual(state.missingEvidence, ["npm test"]);
});

test("request_changes reviewer verdict adds missing evidence", () => {
  const state = applyReviewerVerdict(createVerificationState(), "request_changes", "needs docs");
  assert.equal(isReviewerBlocking(state), false);
  assert.deepEqual(state.missingEvidence, ["reviewer_request_changes"]);
});

test("block reviewer verdict blocks completion and adds missing evidence", () => {
  const state = applyReviewerVerdict(createVerificationState(), "block", "security hole");
  assert.equal(isReviewerBlocking(state), true);
  assert.deepEqual(state.missingEvidence, ["reviewer_block"]);
});

test("missingEvidence stays stable after required evidence is satisfied", () => {
  let state = createVerificationState(["npm test"]);
  state = applyReviewerVerdict(state, "approved", "LGTM");
  state = recordVerificationCheck(state, {
    command: "npm test",
    status: "passed",
    evidence: "all green",
  });
  assert.deepEqual(state.missingEvidence, []);
});
