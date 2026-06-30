import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../../src/tools/types.js";

test("ToolCallSchema accepts canonical viewer tools emitted by the model", () => {
  const calls = [
    { id: "v1", name: "file_view", args: { path: "src/index.ts" } },
    { id: "s1", name: "file_scroll", args: { path: "src/index.ts", direction: "down", lines: 20 } },
    { id: "f1", name: "file_find", args: { path: "src/index.ts", pattern: "runStatusSchema" } },
    { id: "e1", name: "file_edit", args: { path: "src/index.ts", start_line: 1, end_line: 1, new_content: "export {};", reason: "fix export" } },
  ];

  for (const call of calls) {
    const parsed = ToolCallSchema.safeParse(call);
    assert.equal(parsed.success, true, `${call.name} should parse`);
  }
});
