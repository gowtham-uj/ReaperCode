import test from "node:test";
import assert from "node:assert/strict";

import {
  createVerificationState,
  applyReviewerVerdict,
  recordVerificationCheck,
} from "../../src/runtime/verification-state.js";

test("initial reviewer verdict is undefined", () => {
  const state = createVerificationState(["npm test"]);
  assert.equal(state.reviewerVerdict, undefined);
  assert.deepEqual(state.missingEvidence, ["npm test"]);
});

test("approved reviewer verdict does not add missing evidence", () => {
  let state = createVerificationState(["npm test"]);
  state = applyReviewerVerdict(state, "approved", "LGTM");
  assert.deepEqual(state.missingEvidence, ["npm test"]);
});

test("request_changes reviewer verdict remains advisory", () => {
  const state = applyReviewerVerdict(createVerificationState(), "request_changes", "needs docs");
  assert.deepEqual(state.missingEvidence, []);
});

test("block reviewer verdict remains advisory", () => {
  const state = applyReviewerVerdict(createVerificationState(), "block", "security hole");
  assert.deepEqual(state.missingEvidence, []);
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
