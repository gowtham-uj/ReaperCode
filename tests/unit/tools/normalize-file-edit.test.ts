import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../../src/tools/types.js";
import { normalizeToolCall } from "../../../src/tools/normalize.js";

test("normalizeToolCall + ToolCallSchema accepts streamed file_edit with reason", () => {
  const raw = {
    id: "call_683f07324516c1a1624a03a3",
    name: "file_edit",
    function: {
      name: "file_edit",
      arguments: JSON.stringify({
        path: "packages/shared/src/schemas.ts",
        start_line: 35,
        end_line: 35,
        new_content: "  const x = 1;",
        reason: "Fix TS18046 by asserting values as strings",
      }),
    },
  };
  const normalized = normalizeToolCall(raw);
  const r = ToolCallSchema.safeParse(normalized);
  if (!r.success) {
    console.error("FAIL", JSON.stringify(r.error.issues, null, 2));
    console.error("NORMALIZED", JSON.stringify(normalized, null, 2));
  }
  assert.equal(r.success, true);
});