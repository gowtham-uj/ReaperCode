/**
 * Tests for src/governance/completion-safety.ts:
 *  - Subagents cannot call complete_task
 *  - Root caller with no verification is blocked
 *  - Root caller with verification is allowed
 *  - Pending human-approval blocks complete_task (outside sandbox)
 *  - Trusted sandbox relaxes human-approval block
 *  - Unapproved high-risk commands block complete_task
 *  - Decision shape is stable
 */

import test from "node:test";
import assert from "node:assert/strict";

import { canCompleteTask } from "../../../src/governance/completion-safety.js";
import type { CompletionContext } from "../../../src/governance/completion-safety.js";

function base(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    callerRole: "root",
    explicitVerificationPassed: true,
    humanApprovalInFlight: false,
    unapprovedHighRiskCommands: [],
    trustedSandbox: false,
    ...overrides,
  };
}

test("subagents cannot call complete_task (any non-root role)", () => {
  for (const role of ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "scout"]) {
    const d = canCompleteTask(base({ callerRole: role }));
    assert.equal(d.allow, false, `${role} should not be allowed to complete`);
    if (!d.allow) {
      assert.equal(d.code, "not_root");
      assert.deepEqual(d.blockers, ["subagent_cannot_complete"]);
    }
  }
});

test("root with verification not passed is blocked", () => {
  const d = canCompleteTask(base({ callerRole: "root", explicitVerificationPassed: false }));
  assert.equal(d.allow, false);
  if (!d.allow) {
    assert.equal(d.code, "verification_missing");
    assert.deepEqual(d.blockers, ["verification_not_passed"]);
  }
});

test("root with verification passed is allowed", () => {
  const d = canCompleteTask(base({ callerRole: "root", explicitVerificationPassed: true }));
  assert.equal(d.allow, true);
});

test("pending human approval blocks completion (outside sandbox)", () => {
  const d = canCompleteTask(base({ humanApprovalInFlight: true, trustedSandbox: false }));
  assert.equal(d.allow, false);
  if (!d.allow) {
    assert.equal(d.code, "human_in_control");
  }
});

test("trusted sandbox relaxes human-approval block", () => {
  const d = canCompleteTask(base({ humanApprovalInFlight: true, trustedSandbox: true }));
  assert.equal(d.allow, true);
});

test("unapproved high-risk commands block completion", () => {
  const d = canCompleteTask(base({ unapprovedHighRiskCommands: ["rm -rf /", "sudo reboot"] }));
  assert.equal(d.allow, false);
  if (!d.allow) {
    assert.equal(d.code, "unapproved_high_risk");
    assert.ok(d.blockers.length > 0);
  }
});

test("root + verification + no blockers + no in-flight = allow", () => {
  const d = canCompleteTask(base());
  assert.equal(d.allow, true);
  if (d.allow) {
    assert.ok(d.reason.length > 0);
  }
});

test("denial reason is human-readable", () => {
  const d = canCompleteTask(base({ callerRole: "implementer" }));
  assert.equal(d.allow, false);
  if (!d.allow) {
    assert.ok(d.reason.includes("root"), "reason should mention the root requirement");
  }
});
