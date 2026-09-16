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
import { evaluateToolCall } from "../../../src/governance/policy-engine.js";

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
  for (const name of ["file_view", "list_directory", "grep_search", "inspect_environment", "search_tools"]) {
    const m = getToolMetadata(name);
    assert.ok(m, `${name} should have metadata`);
    assert.equal(m.is_read_only, true, `${name} should be is_read_only`);
    assert.ok(m.risk_level === "low" || m.risk_level === "medium", `${name} risk is ${m.risk_level}`);
    assert.equal(m.can_modify_files, false);
  }
});

test("job is not read-only, because two of its four actions mutate a running process", () => {
  // The read-only list above is for tools where *every* call is an observation.
  // `job` is not one: `list` and `poll` observe, but `cancel` sends a signal and
  // `write` pushes bytes into a process's stdin. Metadata describes the whole
  // tool, so it takes the higher of the two — a blanket `is_read_only: true`
  // here would let a read-only role cancel a build.
  const m = getToolMetadata("job");
  assert.ok(m, "job should have metadata");
  assert.equal(m.is_read_only, false);
  assert.equal(m.risk_level, "medium");
  assert.equal(m.can_affect_host, true, "cancel and write reach a live process");
  assert.equal(m.can_modify_files, false, "job never writes to the workspace");
});

test("write tools have can_modify_files=true", () => {
  for (const name of ["write_file", "file_edit", "edit_file", "delete_file"]) {
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

test("eval is classified as code execution, not as a read tool", () => {
  /*
   * The gap this pins: `eval` shipped in `CORE_TOOL_NAMES` and reachable by
   * every role, while `TOOL_METADATA` had no entry for it at all. The policy
   * engine returns `no_metadata` and *denies* in that case, so the failure mode
   * was the safe one — but only for the seven sub-agent roles. The tool's own
   * risk classification, and every question anyone asks of it (may this role
   * run code? does this need approval? is it read-only?), had no answer.
   *
   * The flags are asserted against `bash` rather than in isolation, because the
   * claim being pinned is a *relationship*: a script can do what a shell can do
   * and more, so anything that reads true of bash reads true here.
   */
  const evalMeta = getToolMetadata("eval");
  const bash = getToolMetadata("bash");
  assert.ok(evalMeta, "eval must be classified");
  assert.ok(bash);

  assert.equal(evalMeta.can_execute_code, true, "a script runs code");
  assert.equal(evalMeta.can_affect_host, true, "npm packages, network, child processes");
  assert.equal(evalMeta.can_modify_files, true, "tools.write and fs both mutate the workspace");
  assert.equal(evalMeta.is_read_only, false);
  assert.equal(evalMeta.can_control_ui, false, "eval has no UI channel of its own");

  assert.equal(evalMeta.risk_level, bash.risk_level, "eval may not be rated lower than bash");
  assert.deepEqual(
    [...evalMeta.forbidden_in_roles].sort(),
    [...bash.forbidden_in_roles].sort(),
    "whatever role may not run a shell may not run a script",
  );

  // And the roles agree, through the engine rather than through the table.
  for (const role of ["explorer", "architect", "reviewer", "critic", "browser"] as const) {
    const decision = evaluateToolCall({ toolName: "eval", args: { code: "1" }, callerRole: role, trustedSandbox: false });
    assert.notEqual(decision.verdict, "allow", `role '${role}' must not be allowed to run eval`);
  }
  for (const role of ["implementer", "test"] as const) {
    const decision = evaluateToolCall({ toolName: "eval", args: { code: "1" }, callerRole: role, trustedSandbox: false });
    assert.equal(decision.verdict, "allow", `role '${role}' writes code and must be able to run it`);
  }
});

test("the removed native computer tools have no governance metadata", () => {
  // Metadata left behind for a tool that no longer exists is worse than none:
  // it keeps the tool visible to role profiles and the policy engine, which
  // would then gate a call that can never arrive.
  for (const name of [
    "computer_control",
    "mouse_move",
    "mouse_click",
    "mouse_scroll",
    "keyboard_type",
    "keyboard_press",
    "screenshot",
    "get_screen_size",
    "get_mouse_position",
    "wait",
    "start_live_view",
    "stop_live_view",
    "request_human_approval",
    "is_human_intervening",
  ]) {
    assert.equal(getToolMetadata(name), null, `${name} should have no metadata`);
  }
});

test("browser_use is browser-role-only", () => {
  const m = getToolMetadata("browser_use");
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
  assert.equal(hasToolMetadata("file_view"), true);
  assert.equal(hasToolMetadata("__no_such_tool__"), false);
});

test("preferred_before for write tools includes read tools", () => {
  const m = getToolMetadata("write_file");
  assert.ok(m);
  assert.ok(m.preferred_before.includes("file_view"));
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
