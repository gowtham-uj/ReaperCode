import test from "node:test";
import assert from "node:assert/strict";

import { SandboxPolicy, sandboxToClassification, type SandboxMode } from "../../src/policy/sandbox.js";

function call(name: string, args: Record<string, unknown> = {}): any {
  return { name, args };
}

function evaluate(
  mode: SandboxMode,
  name: string,
  args: Record<string, unknown> = {},
  requireHumanApproval = false,
) {
  return new SandboxPolicy({ mode, requireHumanApproval }).evaluate(call(name, args) as any);
}

test("read_only mode allows reads but blocks writes and shell", () => {
  const policy = new SandboxPolicy({ mode: "read_only" });
  assert.equal(policy.evaluate(call("read_file") as any).verdict, "allow");
  assert.equal(policy.evaluate(call("grep_search") as any).verdict, "allow");
  assert.equal(policy.evaluate(call("git_status") as any).verdict, "allow");
  assert.equal(policy.evaluate(call("write_file") as any).verdict, "needs_human_approval");
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "ls -la" }) as any).verdict,
    "needs_human_approval",
  );
  // Hard-deny still applies even in read_only.
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "rm -rf /" }) as any).verdict,
    "deny",
  );
});

test("workspace_write mode allows workspace shell but blocks network", () => {
  assert.equal(evaluate("workspace_write", "write_file").verdict, "allow");
  assert.equal(evaluate("workspace_write", "run_shell_command", { cmd: "npm test" }).verdict, "allow");
  assert.equal(evaluate("workspace_write", "run_shell_command", { cmd: "git commit -m x" }).verdict, "allow");
  // Network is escalation, not allow.
  const net = evaluate("workspace_write", "run_shell_command", { cmd: "curl https://example.com" });
  assert.equal(net.verdict, "needs_human_approval");
  // Network commands can be promoted to network_disabled (which still
  // denies them, but is the next-strictness step) or danger_full_access.
  assert.ok(net.allowedIn?.includes("danger_full_access"));
});

test("network_disabled mode denies network commands and escalation", () => {
  const policy = new SandboxPolicy({ mode: "network_disabled" });
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "curl https://api.example.com" }) as any).verdict,
    "deny",
  );
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "git push origin main" }) as any).verdict,
    "deny",
  );
  // Local git commit (no network) is still allowed in network_disabled.
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "git commit -m msg" }) as any).verdict,
    "allow",
  );
  // workspace_write is still permitted because git commit doesn't touch the network.
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "npm test 2>&1" }) as any).verdict,
    "allow",
  );
});

test("danger_full_access allows everything except hard-deny", () => {
  const policy = new SandboxPolicy({ mode: "danger_full_access" });
  assert.equal(policy.evaluate(call("write_file") as any).verdict, "allow");
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "curl https://api.example.com" }) as any).verdict,
    "allow",
  );
  // Hard-deny still applies.
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "rm -rf /" }) as any).verdict,
    "deny",
  );
});

test("require_human_approval forces every mutating call through approval", () => {
  const policy = new SandboxPolicy({ mode: "workspace_write", requireHumanApproval: true });
  assert.equal(policy.evaluate(call("write_file") as any).verdict, "needs_human_approval");
  assert.equal(
    policy.evaluate(call("run_shell_command", { cmd: "npm test" }) as any).verdict,
    "needs_human_approval",
  );
  // Reads are still allowed.
  assert.equal(policy.evaluate(call("read_file") as any).verdict, "allow");
});

test("unknown tools default to deny in every mode", () => {
  for (const mode of ["read_only", "workspace_write", "network_disabled", "danger_full_access"] as const) {
    const decision = new SandboxPolicy({ mode }).evaluate(call("not_a_real_tool") as any);
    assert.equal(decision.verdict, "deny", `expected deny in mode ${mode}`);
  }
});

test("sandboxToClassification maps verdicts onto the existing PermissionClassification shape", () => {
  const allow = sandboxToClassification({ verdict: "allow", reason: "ok", ruleId: "x" });
  assert.equal(allow.outcome, "safe");
  const ask = sandboxToClassification({ verdict: "needs_human_approval", reason: "risky" });
  assert.equal(ask.outcome, "needs_confirmation");
  const deny = sandboxToClassification({ verdict: "deny", reason: "forbidden" });
  assert.equal(deny.outcome, "dangerous");
});
