/**
 * Tests for S8: shared tool-allowlist.
 *
 * The previous allowlist in engine.ts drifted: `view_file` was
 * in the args map but missing from `isKnownToolName`. The shared
 * allowlist in src/tools/tool-allowlist.ts is the single source
 * of truth and must include all known tools.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_TOOLS, isKnownToolName, getAllowedArgs } from "../../src/tools/tool-allowlist.js";

test("S8: KNOWN_TOOLS includes the previously-missing view_file", () => {
  assert.equal(KNOWN_TOOLS.has("view_file"), true);
  assert.equal(KNOWN_TOOLS.has("read_file"), true);
  assert.equal(KNOWN_TOOLS.has("run_shell_command"), true);
});

test("S8: getAllowedArgs returns declared args for known tools", () => {
  assert.deepEqual(getAllowedArgs("view_file"), ["path", "startLine", "endLine"]);
  assert.deepEqual(getAllowedArgs("read_file"), ["path", "startLine", "endLine"]);
  assert.deepEqual(getAllowedArgs("activate_skill"), ["name"]);
});

test("S8: getAllowedArgs returns empty for unknown tools", () => {
  assert.deepEqual(getAllowedArgs("not_a_real_tool"), []);
});

test("S8: isKnownToolName matches KNOWN_TOOLS membership", () => {
  assert.equal(isKnownToolName("view_file"), true);
  assert.equal(isKnownToolName("not_a_real_tool"), false);
});
