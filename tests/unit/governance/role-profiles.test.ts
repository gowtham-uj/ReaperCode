/**
 * Tests for src/governance/role-profiles.ts:
 *  - All 8 roles are defined with the right shape
 *  - Read-only roles cannot call write tools
 *  - Write-capable roles can call write tools
 *  - Reviewer and critic cannot edit
 *  - Browser role is browser-only
 *  - Root is the only role with can_complete=true
 *  - shell_risk_tolerance is correctly enforced
 *  - roleAllowsTool is the documented matrix
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ROLE_PROFILES, roleAllowsTool, roleToleratesCommandRisk, getRoleProfile, listRoleNames } from "../../../src/governance/role-profiles.js";
import type { PolicyRole } from "../../../src/governance/tool-metadata.js";

test("all 8 roles are defined", () => {
  const names = listRoleNames().sort();
  assert.deepEqual(names, ["architect", "browser", "critic", "explorer", "implementer", "reviewer", "root", "test"]);
});

test("each role profile has a complete shape", () => {
  for (const [name, p] of Object.entries(ROLE_PROFILES)) {
    assert.equal(p.role, name);
    assert.ok(p.description.length > 0);
    assert.ok(Array.isArray(p.allowed_tools));
    assert.ok(Array.isArray(p.forbidden_tools));
    assert.equal(typeof p.can_write, "boolean");
    assert.equal(typeof p.can_run_commands, "boolean");
    assert.ok(["low-only", "medium", "high"].includes(p.shell_risk_tolerance));
    assert.equal(typeof p.can_complete, "boolean");
    assert.equal(typeof p.can_spawn_agents, "boolean");
  }
});

test("read-only roles cannot call write tools", () => {
  const readOnlyRoles: PolicyRole[] = ["explorer", "architect", "critic", "browser"];
  const writeTools = ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"];
  for (const role of readOnlyRoles) {
    for (const tool of writeTools) {
      assert.equal(roleAllowsTool(role, tool), false, `${role} should not be allowed to call ${tool}`);
    }
  }
});

test("implementer, test, and root can call write tools", () => {
  for (const role of ["implementer", "test", "root"] as PolicyRole[]) {
    for (const tool of ["write_file", "edit_file", "replace_in_file", "delete_file"]) {
      assert.equal(roleAllowsTool(role, tool), true, `${role} should be allowed to call ${tool}`);
    }
  }
});

test("reviewer cannot edit (write_file / edit_file / replace_in_file)", () => {
  for (const tool of ["write_file", "edit_file", "replace_in_file", "replace_symbol", "delete_file"]) {
    assert.equal(roleAllowsTool("reviewer", tool), false);
  }
});

test("reviewer can read and run shell (read-only inspection)", () => {
  for (const tool of ["read_file", "view_file", "grep_search", "list_directory", "run_shell_command"]) {
    assert.equal(roleAllowsTool("reviewer", tool), true);
  }
});

test("critic cannot run shell", () => {
  assert.equal(ROLE_PROFILES.critic.can_run_commands, false);
  assert.equal(roleAllowsTool("critic", "run_shell_command"), false);
});

test("browser is the only role allowed to call browser_control", () => {
  for (const role of listRoleNames()) {
    if (role === "browser") continue;
    // At the role-profile level root is allowed (root has the
    // full allowlist), but the *metadata* forbids root from
    // calling browser_control. The full policy engine enforces
    // this; roleAllowsTool alone does not.
    if (role === "root") continue;
    assert.equal(roleAllowsTool(role, "browser_control"), false, `${role} should not be allowed to call browser_control`);
  }
  assert.equal(roleAllowsTool("browser", "browser_control"), true);
});

test("root is the only role with can_complete=true", () => {
  for (const [name, p] of Object.entries(ROLE_PROFILES)) {
    if (name === "root") {
      assert.equal(p.can_complete, true);
    } else {
      assert.equal(p.can_complete, false, `${name} should not have can_complete=true`);
    }
  }
});

test("only root can call complete_task", () => {
  for (const [name, p] of Object.entries(ROLE_PROFILES)) {
    const allowed = roleAllowsTool(name as PolicyRole, "complete_task");
    if (name === "root") {
      assert.equal(allowed, true);
    } else {
      assert.equal(allowed, false, `${name} should not be allowed to call complete_task`);
    }
  }
});

test("shell_risk_tolerance matches shell risk level", () => {
  // low-only roles only accept low
  for (const role of ["explorer", "architect", "critic", "browser"] as PolicyRole[]) {
    assert.equal(roleToleratesCommandRisk(role, "low"), true);
    assert.equal(roleToleratesCommandRisk(role, "medium"), false);
    assert.equal(roleToleratesCommandRisk(role, "high"), false);
  }
  // medium roles accept low + medium
  for (const role of ["implementer", "test", "reviewer"] as PolicyRole[]) {
    assert.equal(roleToleratesCommandRisk(role, "low"), true);
    assert.equal(roleToleratesCommandRisk(role, "medium"), true);
    assert.equal(roleToleratesCommandRisk(role, "high"), false);
  }
  // root accepts everything (high still audited)
  assert.equal(roleToleratesCommandRisk("root", "low"), true);
  assert.equal(roleToleratesCommandRisk("root", "medium"), true);
  assert.equal(roleToleratesCommandRisk("root", "high"), true);
});

test("getRoleProfile returns null for unknown role", () => {
  assert.equal(getRoleProfile("nope"), null);
});

test("subagents (non-root) cannot spawn agents by default", () => {
  for (const [name, p] of Object.entries(ROLE_PROFILES)) {
    if (name === "root") continue;
    assert.equal(p.can_spawn_agents, false, `${name} should not spawn agents`);
  }
});
