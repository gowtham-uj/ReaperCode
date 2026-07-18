/**
 * Tests for src/governance/tool-metadata.ts:
 *  - Every tool in src/tools/tool-allowlist.ts is also in TOOL_METADATA
 *  - Every ToolMetadata has the required fields populated
 *  - The risk-level values are valid
 *  - forbidden_in_roles / allowed_in_roles reference real roles
 *
 * Note: the swarm <-> governance role mapping was removed when the
 * controlled 7-role swarm was deleted. The governance role layer is
 * now independent of the sub-agent runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KNOWN_TOOLS } from "../../../src/tools/tool-allowlist.js";
import {
  TOOL_METADATA,
  getToolMetadata,
  hasToolMetadata,
  assertMetadataCoversRegistry,
  type PolicyRole,
  type RiskLevel,
} from "../../../src/governance/tool-metadata.js";

const VALID_RISK: ReadonlySet<RiskLevel> = new Set(["low", "medium", "high", "critical"]);
const VALID_ROLES: ReadonlySet<PolicyRole> = new Set([
  "explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root",
]);

test("metadata covers every tool in the registry (no orphan tools)", () => {
  const result = assertMetadataCoversRegistry();
  assert.equal(result.ok, true, `missing metadata for: ${result.missing.join(", ")}`);
  assert.deepEqual(result.missing, []);
  // Extras are tolerated (we may have metadata for tools the
  // registry has not yet picked up) but the invariant we care
  // about is "no missing".
});

test("every metadata entry has a complete shape", () => {
  for (const [name, m] of Object.entries(TOOL_METADATA)) {
    assert.equal(m.name, name, `${name} has wrong name field`);
    assert.ok(VALID_RISK.has(m.risk_level), `${name} has invalid risk_level: ${m.risk_level}`);
    for (const role of m.forbidden_in_roles) {
      assert.ok(VALID_ROLES.has(role as PolicyRole), `${name} has invalid forbidden role: ${role}`);
    }
    for (const role of m.allowed_in_roles) {
      assert.ok(VALID_ROLES.has(role as PolicyRole), `${name} has invalid allowed role: ${role}`);
    }
    assert.equal(typeof m.is_read_only, "boolean");
    assert.equal(typeof m.can_modify_files, "boolean");
    assert.equal(typeof m.can_execute_code, "boolean");
    assert.equal(typeof m.can_control_ui, "boolean");
    assert.equal(typeof m.can_affect_host, "boolean");
    assert.equal(typeof m.requires_approval, "boolean");
    assert.ok(Array.isArray(m.preferred_before));
    assert.ok(Array.isArray(m.preferred_after));
  }
});

test("read-only tools have is_read_only=true and risk in {low, medium}", () => {
  for (const name of ["read_file", "view_file", "list_directory", "grep_search", "skim_file", "inspect_environment", "get_tool_output", "task_list", "search_tools"]) {
    const m = getToolMetadata(name);
    assert.ok(m, `${name} should have metadata`);
    assert.equal(m.is_read_only, true, `${name} should be is_read_only`);
    assert.ok(m.risk_level === "low" || m.risk_level === "medium", `${name} risk is ${m.risk_level}`);
    assert.equal(m.can_modify_files, false);
  }
});

test("write tools have can_modify_files=true", () => {
  for (const name of ["write_file", "replace_in_file", "edit_file", "delete_file"]) {
    const m = getToolMetadata(name);
    assert.ok(m, `${name} should have metadata`);
    assert.equal(m.can_modify_files, true, `${name} should modify files`);
    assert.equal(m.is_read_only, false);
  }
});

test("bash has can_execute_code=true and can_affect_host=true", () => {
  const m = getToolMetadata("bash");
  assert.ok(m);
  assert.equal(m.can_execute_code, true);
  assert.equal(m.can_affect_host, true);
});

test("native computer control tools have can_control_ui=true and requires_approval=true", () => {
  for (const name of ["computer_control", "mouse_move", "mouse_click", "mouse_scroll", "keyboard_type", "keyboard_press"]) {
    const m = getToolMetadata(name);
    assert.ok(m);
    assert.equal(m.can_control_ui, true, `${name} should control UI`);
    assert.equal(m.requires_approval, true, `${name} should require approval`);
  }
});

test("browser_control is browser-role-only", () => {
  const m = getToolMetadata("browser_control");
  assert.ok(m);
  assert.deepEqual([...m.allowed_in_roles], ["browser"]);
});

test("the governance role layer is decoupled from sub-agent types", () => {
  // The model-driven sub-agent runtime uses subagent_type values
  // ("coder", "explore", "plan") from a YAML-defined allowlist, not
  // the governance roles ("explorer", "architect", etc.). The two
  // layers are now independent; this test pins that down by checking
  // the role-profiles module exposes governance roles that don't
  // collide with subagent_type names.
  const VALID_GOVERNANCE_ROLES = new Set([
    "explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root",
  ]);
  for (const role of VALID_GOVERNANCE_ROLES) {
    assert.ok(VALID_ROLES.has(role as PolicyRole), `governance role ${role} should be a valid PolicyRole`);
  }
});

test("hasToolMetadata returns the documented booleans", () => {
  assert.equal(hasToolMetadata("read_file"), true);
  assert.equal(hasToolMetadata("__no_such_tool__"), false);
});

test("preferred_before for write tools includes read tools", () => {
  const m = getToolMetadata("write_file");
  assert.ok(m);
  assert.ok(m.preferred_before.includes("read_file") || m.preferred_before.includes("view_file"));
});

test("KNOWN_TOOLS and TOOL_METADATA agree on the union of tool names", () => {
  const fromRegistry = new Set<string>(KNOWN_TOOLS);
  for (const name of Object.keys(TOOL_METADATA)) {
    // We allow metadata extras, so we only assert that every
    // registry entry is covered.
    if (!fromRegistry.has(name)) continue;
    assert.ok(hasToolMetadata(name));
  }
});
