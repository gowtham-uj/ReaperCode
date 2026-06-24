/**
 * Tests for src/governance/preferred-ordering.ts:
 *  - write tools warn when no read has been done in the run
 *  - browser_control is preferred over computer_control
 *  - mouse/keyboard tools suggest a prior screenshot
 *  - complete_task suggests a prior test run
 *  - Empty history returns no advisories
 *  - hasOrderingRules is accurate
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getOrderingAdvisories, hasOrderingRules, getMetadataDrivenAdvisories } from "../../../src/governance/preferred-ordering.js";

test("write_file with no prior read returns an advisory", () => {
  const adv = getOrderingAdvisories({ currentTool: "write_file", recentTools: [], isSubagentCall: false });
  // We allow either an info or warn advisory; the key invariant
  // is that the engine surfaces *some* advice when writes happen
  // before reads.
  assert.ok(adv.length > 0, "should surface at least one advisory");
  assert.ok(adv.some((a) => a.ruleId.startsWith("ordering.write")));
});

test("write_file after read_file + inspect returns no write-without-read advisory", () => {
  const adv = getOrderingAdvisories({
    currentTool: "write_file",
    recentTools: ["inspect_environment", "list_directory", "read_file"],
    isSubagentCall: false,
  });
  // The "write_without_read" warning should NOT fire.
  assert.ok(!adv.some((a) => a.ruleId === "ordering.write_without_read"), `unexpected warn: ${adv.map(a => a.ruleId).join(",")}`);
});

test("edit_file without prior read returns a warning", () => {
  const adv = getOrderingAdvisories({ currentTool: "edit_file", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.edit_without_read"));
});

test("replace_in_file without prior read returns a warning", () => {
  const adv = getOrderingAdvisories({ currentTool: "replace_in_file", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.replace_without_read"));
});

test("delete_file without prior read returns a warning", () => {
  const adv = getOrderingAdvisories({ currentTool: "delete_file", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.delete_without_read"));
});

test("browser_control after computer_control triggers the browser-over-computer advisory", () => {
  const adv = getOrderingAdvisories({
    currentTool: "browser_control",
    recentTools: ["computer_control"],
    isSubagentCall: false,
  });
  assert.ok(adv.some((a) => a.ruleId === "ordering.computer_preferred_over_browser"));
});

test("computer_control as the first computer call gets a browser-preferred hint", () => {
  const adv = getOrderingAdvisories({
    currentTool: "computer_control",
    recentTools: [],
    isSubagentCall: false,
  });
  assert.ok(adv.some((a) => a.ruleId === "ordering.browser_preferred_over_computer"));
});

test("mouse_click without screenshot gets an advisory", () => {
  const adv = getOrderingAdvisories({ currentTool: "mouse_click", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.click_no_screenshot"));
});

test("keyboard_type without screenshot gets an advisory", () => {
  const adv = getOrderingAdvisories({ currentTool: "keyboard_type", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.type_no_screenshot"));
});

test("complete_task with a prior shell run does not fire the no-test advisory", () => {
  const adv = getOrderingAdvisories({
    currentTool: "complete_task",
    recentTools: ["read_file", "run_shell_command"],
    isSubagentCall: false,
  });
  assert.ok(!adv.some((a) => a.ruleId === "ordering.complete_no_test"));
});

test("complete_task with no shell in history fires the no-test warning", () => {
  const adv = getOrderingAdvisories({
    currentTool: "complete_task",
    recentTools: ["read_file", "view_file"],
    isSubagentCall: false,
  });
  assert.ok(adv.some((a) => a.ruleId === "ordering.complete_no_test"));
});

test("empty history returns no advisories for tools that don't have rules", () => {
  // task_list has no rules
  assert.deepEqual(getOrderingAdvisories({ currentTool: "task_list", recentTools: [], isSubagentCall: false }), []);
  // search_tools has no rules
  assert.deepEqual(getOrderingAdvisories({ currentTool: "search_tools", recentTools: [], isSubagentCall: false }), []);
});

test("hasOrderingRules returns false for unordered tools", () => {
  assert.equal(hasOrderingRules("read_file"), false);
  assert.equal(hasOrderingRules("task_list"), false);
  assert.equal(hasOrderingRules("__nope__"), false);
});

test("hasOrderingRules returns true for ordered tools", () => {
  assert.equal(hasOrderingRules("write_file"), true);
  assert.equal(hasOrderingRules("edit_file"), true);
  assert.equal(hasOrderingRules("computer_control"), true);
  assert.equal(hasOrderingRules("complete_task"), true);
});

test("metadata-driven advisories look at preferred_before", () => {
  const adv = getMetadataDrivenAdvisories("write_file", []);
  // write_file's preferred_before includes read_file, so we
  // should see at least one metadata-driven advisory.
  assert.ok(adv.length > 0, "should surface at least one metadata advisory");
  // The current implementation rolls all preferred tools into a
  // single advisory (so the rule id has no per-tool suffix).
  assert.ok(adv.some((a) => a.ruleId.startsWith("metadata.preferred_before.write_file")));
});

test("metadata-driven advisories do not fire for satisfied preferences", () => {
  const adv = getMetadataDrivenAdvisories("write_file", ["read_file", "view_file"]);
  // read_file / view_file are in preferred_before, so no advisories.
  assert.equal(adv.length, 0);
});
