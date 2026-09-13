/**
 * Tests for src/governance/preferred-ordering.ts:
 *  - write tools warn when no read has been done in the run
 *  - metadata-driven advisories (read before write, etc.)
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

test("write_file after file_view + inspect returns no write-without-read advisory", () => {
  const adv = getOrderingAdvisories({
    currentTool: "write_file",
    recentTools: ["inspect_environment", "list_directory", "file_view"],
    isSubagentCall: false,
  });
  // The "write_without_read" warning should NOT fire.
  assert.ok(!adv.some((a) => a.ruleId === "ordering.write_without_read"), `unexpected warn: ${adv.map(a => a.ruleId).join(",")}`);
});

test("edit_file without prior read returns a warning", () => {
  const adv = getOrderingAdvisories({ currentTool: "edit_file", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.edit_without_read"));
});


test("delete_file without prior read returns a warning", () => {
  const adv = getOrderingAdvisories({ currentTool: "delete_file", recentTools: [], isSubagentCall: false });
  assert.ok(adv.some((a) => a.ruleId === "ordering.delete_without_read"));
});

test("the native-computer advisories are gone with the tools they described", () => {
  // "take a screenshot before you click" is advice about a desktop tool that
  // no longer exists. Leaving the rule in would fire advisories telling the
  // model to use a tool it cannot call.
  for (const currentTool of ["computer_control", "mouse_click", "keyboard_type"]) {
    assert.equal(hasOrderingRules(currentTool), false, `${currentTool} should have no rules`);
    assert.deepEqual(
      getOrderingAdvisories({ currentTool, recentTools: ["screenshot"], isSubagentCall: false }),
      [],
    );
  }
});

test("empty history returns no advisories for tools that don't have rules", () => {
  // search_tools has no rules
  assert.deepEqual(getOrderingAdvisories({ currentTool: "search_tools", recentTools: [], isSubagentCall: false }), []);
});

test("hasOrderingRules returns false for unordered tools", () => {
  assert.equal(hasOrderingRules("file_view"), false);
  assert.equal(hasOrderingRules("__nope__"), false);
});

test("hasOrderingRules returns true for ordered tools", () => {
  assert.equal(hasOrderingRules("write_file"), true);
  assert.equal(hasOrderingRules("edit_file"), true);
  assert.equal(hasOrderingRules("delete_file"), true);
});

test("metadata-driven advisories look at preferred_before", () => {
  const adv = getMetadataDrivenAdvisories("write_file", []);
  // write_file's preferred_before includes file_view, so we
  // should see at least one metadata-driven advisory.
  assert.ok(adv.length > 0, "should surface at least one metadata advisory");
  // The current implementation rolls all preferred tools into a
  // single advisory (so the rule id has no per-tool suffix).
  assert.ok(adv.some((a) => a.ruleId.startsWith("metadata.preferred_before.write_file")));
});

test("metadata-driven advisories do not fire for satisfied preferences", () => {
  const adv = getMetadataDrivenAdvisories("write_file", ["file_view", "grep_search"]);
  // file_view and grep_search are both in preferred_before, so no advisories.
  assert.equal(adv.length, 0);
});
