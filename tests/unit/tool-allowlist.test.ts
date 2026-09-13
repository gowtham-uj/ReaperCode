/**
 * Tests for S8: shared tool-allowlist.
 *
 * The old allowlist drifted from the registry: a name could be present in the
 * args map but missing from `isKnownToolName`, which left a call the engine
 * would neither strip (unknown) nor pass (also unknown). Both surfaces are now
 * derived from the same map in src/tools/tool-allowlist.ts.
 *
 * Names here are canonical. Aliases such as `view_file` are resolved by
 * `normalizeToolCall` before this layer, so they have no entry of their own.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_TOOLS, isKnownToolName, getAllowedArgs } from "../../src/tools/tool-allowlist.js";

test("S8: KNOWN_TOOLS matches the canonical registry names", () => {
  assert.equal(KNOWN_TOOLS.has("file_view"), true);
  assert.equal(KNOWN_TOOLS.has("read_file"), false);
  assert.equal(KNOWN_TOOLS.has("bash"), true);
});

test("S8: getAllowedArgs returns declared args for known tools", () => {
  assert.deepEqual(getAllowedArgs("file_view"), ["path", "start_line", "window"]);
  assert.deepEqual(getAllowedArgs("read_file"), []);
  assert.deepEqual(getAllowedArgs("activate_skill"), ["name"]);
});

test("S8: getAllowedArgs returns empty for unknown tools", () => {
  assert.deepEqual(getAllowedArgs("not_a_real_tool"), []);
  assert.deepEqual(getAllowedArgs("view_file"), []);
});

test("S8: isKnownToolName matches KNOWN_TOOLS membership", () => {
  for (const name of KNOWN_TOOLS) {
    assert.equal(isKnownToolName(name), true, `${name} is in KNOWN_TOOLS but not recognized`);
  }
  assert.equal(isKnownToolName("not_a_real_tool"), false);
  assert.equal(isKnownToolName("view_file"), false);
});
