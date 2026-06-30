import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCommandPolicy } from "../../src/policy/rules.js";

test("global node tool installs are not hard-denied in allow-all runtime", () => {
  const decision = evaluateCommandPolicy("which pnpm || npm install -g pnpm", "allow_all");
  assert.notEqual(decision.ruleId, "hard_deny_global_tool_install");
  assert.notEqual(decision.outcome, "deny");
});

test("catastrophic shell commands remain hard-denied", () => {
  const decision = evaluateCommandPolicy("rm -rf /", "allow_all");
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.ruleId, "hard_deny_rm_root");
});
