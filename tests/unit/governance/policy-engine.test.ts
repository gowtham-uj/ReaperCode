/**
 * Tests for src/governance/policy-engine.ts:
 *  - Role-based allow/deny
 *  - Risky shell blocking
 *  - Browser preferred over computer (advisory)
 *  - Native OS control requires approval
 *  - complete_task blocked before verification
 *  - complete_task allowed after verification
 *  - Subagents cannot call complete_task
 *  - Reviewers cannot edit
 *  - Critics are read-only
 *  - Implementers cannot bypass verification
 *  - search_tools only reveals schemas
 *  - Trusted-sandbox shortcut for high-risk commands
 *  - Ordering advisories are surfaced (advisory only, not blocking)
 *  - Unknown tool names are denied
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateToolCall, isPolicyDenial, isPolicyApprovalRequired } from "../../../src/governance/policy-engine.js";

test("role allow: root can call read_file", () => {
  const d = evaluateToolCall({ toolName: "read_file", args: { path: "/tmp/x" }, callerRole: "root", trustedSandbox: false });
  assert.equal(d.verdict, "allow");
  assert.equal(d.code, "allow");
});

test("role deny: explorer cannot call write_file", () => {
  const d = evaluateToolCall({ toolName: "write_file", args: { path: "/tmp/x", content: "hi" }, callerRole: "explorer", trustedSandbox: false });
  assert.equal(d.verdict, "deny");
  assert.equal(d.code, "forbidden_in_role");
});

test("role deny: critic cannot call run_shell_command", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "ls" }, callerRole: "critic", trustedSandbox: false });
  assert.equal(d.verdict, "deny");
  // Critic cannot run shell — either shell_risk_exceeded (because low-only) or forbidden_in_role.
  assert.ok(["shell_risk_exceeded", "forbidden_in_role", "forbidden_by_metadata", "not_in_role_allowlist"].includes(d.code), `unexpected code: ${d.code}`);
});

test("role deny: reviewer cannot call write_file (reviewer is read-only on edits)", () => {
  const d = evaluateToolCall({ toolName: "write_file", args: { path: "/tmp/x", content: "hi" }, callerRole: "reviewer", trustedSandbox: false });
  assert.equal(d.verdict, "deny");
});

test("role allow: implementer can call write_file and edit_file", () => {
  for (const t of ["write_file", "edit_file", "replace_in_file"]) {
    const d = evaluateToolCall({ toolName: t, args: { path: "/tmp/x" }, callerRole: "implementer", trustedSandbox: false });
    assert.equal(d.verdict, "allow", `${t} should be allowed for implementer; got ${d.code}`);
  }
});

test("shell risk: low-risk command is allowed for medium-tolerance role", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "ls -la" }, callerRole: "implementer", trustedSandbox: false });
  assert.equal(d.verdict, "allow");
  assert.equal(d.shellRisk?.risk, "low");
});

test("shell risk: medium-risk command is allowed for implementer (medium tolerance)", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "npm install" }, callerRole: "implementer", trustedSandbox: false });
  assert.equal(d.verdict, "allow");
  assert.equal(d.shellRisk?.risk, "medium");
});

test("shell risk: high-risk command requires approval for implementer (non-sandbox)", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "rm -rf /" }, callerRole: "implementer", trustedSandbox: false });
  assert.equal(d.verdict, "require_approval");
  // The high-risk gate fires before the role-tolerance gate, so
  // an implementer gets `shell_approval_required` (a soft
  // approval request) rather than a hard `shell_risk_exceeded`
  // deny. A medium-tolerance role can still see this gate fire
  // (the alternative would be either always-deny or always-allow,
  // both of which are worse for a controlled multi-role system).
  assert.equal(d.code, "shell_approval_required");
  assert.ok(isPolicyApprovalRequired(d));
});

test("shell risk: trusted sandbox skips the high-risk approval gate for root", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "rm -rf /tmp/some-artifact" }, callerRole: "root", trustedSandbox: true });
  // rm -rf is high; in trusted sandbox, root is allowed to proceed.
  // Note: rm -rf / still matches the hard-deny shell path; the policy
  // engine alone does not enforce hard-deny, the executor's
  // evaluateCommandPolicy does. So at the governance layer this
  // should be "allow" (with high risk audited).
  assert.equal(d.verdict, "allow");
  assert.equal(d.shellRisk?.risk, "high");
});

test("shell risk: explorer is denied any shell command", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "ls" }, callerRole: "explorer", trustedSandbox: false });
  assert.equal(d.verdict, "deny");
});

test("computer_control requires approval unless in trusted sandbox", () => {
  const d = evaluateToolCall({ toolName: "computer_control", args: {}, callerRole: "root", trustedSandbox: false });
  assert.equal(d.verdict, "require_approval");
  assert.equal(d.code, "approval_required");
});

test("computer_control allows when trustedSandbox=true (root only)", () => {
  const d = evaluateToolCall({ toolName: "computer_control", args: {}, callerRole: "root", trustedSandbox: true });
  assert.equal(d.verdict, "allow");
});

test("computer_control is denied for any non-root role even in trusted sandbox", () => {
  // Per metadata, computer_control has empty allowed_in_roles.
  // Even a browser role (which is allowed to call screenshot
  // and get_screen_size) is not allowed to call computer_control.
  const d = evaluateToolCall({ toolName: "computer_control", args: {}, callerRole: "browser", trustedSandbox: true });
  assert.equal(d.verdict, "deny");
});

test("mouse_click requires approval", () => {
  const d = evaluateToolCall({ toolName: "mouse_click", args: {}, callerRole: "root", trustedSandbox: false });
  assert.equal(d.verdict, "require_approval");
  assert.equal(d.code, "approval_required");
});

test("browser_control is browser-only; other roles are denied", () => {
  for (const role of ["explorer", "architect", "implementer", "test", "reviewer", "critic", "root"]) {
    const d = evaluateToolCall({ toolName: "browser_control", args: {}, callerRole: role, trustedSandbox: false });
    assert.equal(d.verdict, "deny", `${role} should not be allowed to call browser_control`);
  }
  const d = evaluateToolCall({ toolName: "browser_control", args: {}, callerRole: "browser", trustedSandbox: false });
  assert.equal(d.verdict, "allow");
});

test("complete_task is blocked when verification is not passed", () => {
  const d = evaluateToolCall({
    toolName: "complete_task",
    args: { summary: "Done" },
    callerRole: "root",
    trustedSandbox: false,
    completion: { explicitVerificationPassed: false, humanApprovalInFlight: false, unapprovedHighRiskCommands: [], trustedSandbox: false },
  });
  assert.equal(d.verdict, "deny");
  assert.equal(d.code, "completion_blocked");
});

test("complete_task is allowed when verification is passed", () => {
  const d = evaluateToolCall({
    toolName: "complete_task",
    args: { summary: "Done" },
    callerRole: "root",
    trustedSandbox: false,
    completion: { explicitVerificationPassed: true, humanApprovalInFlight: false, unapprovedHighRiskCommands: [], trustedSandbox: false },
  });
  assert.equal(d.verdict, "allow");
});

test("subagents cannot call complete_task", () => {
  for (const role of ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser"]) {
    const d = evaluateToolCall({
      toolName: "complete_task",
      args: { summary: "Done" },
      callerRole: role,
      trustedSandbox: false,
      completion: { explicitVerificationPassed: true, humanApprovalInFlight: false, unapprovedHighRiskCommands: [], trustedSandbox: false },
    });
    assert.equal(d.verdict, "deny", `${role} should not be allowed to call complete_task`);
  }
});

test("implementer cannot bypass verification to complete", () => {
  const d = evaluateToolCall({
    toolName: "complete_task",
    args: { summary: "Done" },
    callerRole: "implementer",
    trustedSandbox: false,
    completion: { explicitVerificationPassed: true, humanApprovalInFlight: false, unapprovedHighRiskCommands: [], trustedSandbox: false },
  });
  // The role-based check fires first (implementer is not allowed
  // to call complete_task at all), giving a deny with code
  // 'forbidden_in_role'.
  assert.equal(d.verdict, "deny");
  assert.equal(d.code, "forbidden_in_role");
});

test("search_tools is read-only and available to all roles", () => {
  for (const role of ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"]) {
    const d = evaluateToolCall({ toolName: "search_tools", args: { query: "foo" }, callerRole: role, trustedSandbox: false });
    assert.equal(d.verdict, "allow", `search_tools should be allowed for ${role}; got ${d.code}`);
    assert.equal(d.metadata?.is_read_only, true);
  }
});

test("unknown tool is denied (no metadata)", () => {
  const d = evaluateToolCall({ toolName: "__no_such_tool__", args: {}, callerRole: "root", trustedSandbox: false });
  assert.equal(d.verdict, "deny");
  assert.equal(d.code, "no_metadata");
});

test("ordering advisories are surfaced for write without read", () => {
  const d = evaluateToolCall({
    toolName: "write_file",
    args: { path: "/tmp/x", content: "hi" },
    callerRole: "root",
    trustedSandbox: false,
    recentTools: [],
  });
  assert.equal(d.verdict, "allow");
  assert.ok(d.advisories.some((a) => a.ruleId.startsWith("ordering.write")));
});

test("ordering advisories are not surfaced when preferences are met", () => {
  const d = evaluateToolCall({
    toolName: "write_file",
    args: { path: "/tmp/x", content: "hi" },
    callerRole: "root",
    trustedSandbox: false,
    recentTools: ["read_file", "view_file"],
  });
  // The "write_without_read" warning should not fire.
  assert.ok(!d.advisories.some((a) => a.ruleId === "ordering.write_without_read"), `unexpected: ${d.advisories.map(a => a.ruleId).join(",")}`);
});

test("isPolicyDenial and isPolicyApprovalRequired are accurate", () => {
  const allow = evaluateToolCall({ toolName: "read_file", args: { path: "/tmp/x" }, callerRole: "root", trustedSandbox: false });
  const deny = evaluateToolCall({ toolName: "__nope__", args: {}, callerRole: "root", trustedSandbox: false });
  const approval = evaluateToolCall({ toolName: "computer_control", args: {}, callerRole: "root", trustedSandbox: false });
  assert.equal(isPolicyDenial(allow), false);
  assert.equal(isPolicyApprovalRequired(allow), false);
  assert.equal(isPolicyDenial(deny), true);
  assert.equal(isPolicyApprovalRequired(deny), false);
  assert.equal(isPolicyDenial(approval), false);
  assert.equal(isPolicyApprovalRequired(approval), true);
});

test("isPolicyDenial flags completion_blocked as a denial", () => {
  const d = evaluateToolCall({
    toolName: "complete_task",
    args: { summary: "Done" },
    callerRole: "root",
    trustedSandbox: false,
    completion: { explicitVerificationPassed: false, humanApprovalInFlight: false, unapprovedHighRiskCommands: [], trustedSandbox: false },
  });
  assert.equal(d.verdict, "deny");
  assert.equal(isPolicyDenial(d), true);
});

test("metadata is surfaced on the decision for downstream consumers", () => {
  const d = evaluateToolCall({ toolName: "read_file", args: { path: "/tmp/x" }, callerRole: "root", trustedSandbox: false });
  assert.ok(d.metadata);
  assert.equal(d.metadata.name, "read_file");
  assert.equal(d.metadata.risk_level, "low");
});

test("shell risk finding is surfaced on the decision for run_shell_command", () => {
  const d = evaluateToolCall({ toolName: "run_shell_command", args: { cmd: "sudo apt install vim" }, callerRole: "root", trustedSandbox: false });
  // The decision itself is require_approval, but the shell risk
  // finding should still be set.
  assert.ok(d.shellRisk);
  assert.equal(d.shellRisk.risk, "high");
  assert.equal(d.shellRisk.ruleId, "shell.sudo");
});

test("default to no advisories for a tool that has no rules and no history", () => {
  const d = evaluateToolCall({ toolName: "task_list", args: {}, callerRole: "root", trustedSandbox: false, recentTools: [] });
  assert.equal(d.advisories.length, 0);
});
