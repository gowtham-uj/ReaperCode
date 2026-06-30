import test from "node:test";
import assert from "node:assert/strict";

import { getAllowedArgs, isKnownToolName } from "../../../src/tools/tool-allowlist.js";

test("tool allowlist knows canonical viewer tools and preserves their args", () => {
  assert.equal(isKnownToolName("file_view"), true);
  assert.equal(isKnownToolName("file_scroll"), true);
  assert.equal(isKnownToolName("file_find"), true);
  assert.equal(isKnownToolName("file_edit"), true);

  assert.deepEqual(getAllowedArgs("file_view"), ["path", "start_line", "window"]);
  assert.deepEqual(getAllowedArgs("file_scroll"), ["path", "direction", "lines"]);
  assert.deepEqual(getAllowedArgs("file_find"), ["path", "pattern", "start_line"]);
  assert.deepEqual(getAllowedArgs("file_edit"), ["path", "start_line", "end_line", "new_content", "reason"]);
});
