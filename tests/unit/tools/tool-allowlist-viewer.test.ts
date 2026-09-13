import test from "node:test";
import assert from "node:assert/strict";

import { getAllowedArgs, isKnownToolName } from "../../../src/tools/tool-allowlist.js";

test("tool allowlist knows canonical viewer tools and preserves their args", () => {
  assert.equal(isKnownToolName("file_view"), true);
  assert.equal(isKnownToolName("file_find"), true);
  assert.equal(isKnownToolName("file_edit"), true);

  assert.deepEqual(getAllowedArgs("file_view"), ["path", "start_line", "window"]);
  assert.deepEqual(getAllowedArgs("file_find"), ["path", "pattern", "start_line"]);
  assert.deepEqual(getAllowedArgs("file_edit"), ["path", "start_line", "end_line", "new_content", "reason"]);
});

test("the allowlist does not carry a retired name's argument list", () => {
  // `file_scroll`'s old allowlist entry was `["path", "direction", "lines"]`.
  // Leaving it behind would keep advertising a cursor-shaped argument set for a
  // tool that no longer has a cursor — a model reading the allowlist would
  // learn to pass `direction`, and `file_view` would drop it.
  assert.equal(isKnownToolName("file_scroll"), false);
  assert.deepEqual(getAllowedArgs("file_scroll"), []);
});
