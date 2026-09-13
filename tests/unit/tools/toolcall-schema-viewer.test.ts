import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../../src/tools/types.js";

test("ToolCallSchema accepts canonical viewer tools emitted by the model", () => {
  const calls = [
    { id: "v1", name: "file_view", args: { path: "src/index.ts" } },
    { id: "v2", name: "file_view", args: { path: "src/index.ts", start_line: 40, window: 20 } },
    { id: "f1", name: "file_find", args: { path: "src/index.ts", pattern: "runStatusSchema" } },
    { id: "e1", name: "file_edit", args: { path: "src/index.ts", start_line: 1, end_line: 1, new_content: "export {};", reason: "fix export" } },
  ];

  for (const call of calls) {
    const parsed = ToolCallSchema.safeParse(call);
    assert.equal(parsed.success, true, `${call.name} should parse`);
  }
});

test("ToolCallSchema refuses a retired viewer name", () => {
  // Normalization is what rescues a model that emits `file_scroll`, and it runs
  // before this schema. The schema itself sees only canonical names — so a
  // retired one reaching it un-normalized is a bug upstream, and saying so here
  // is better than silently accepting a shape nothing dispatches.
  const parsed = ToolCallSchema.safeParse({
    id: "s1",
    name: "file_scroll",
    args: { path: "src/index.ts", direction: "down", lines: 20 },
  });
  assert.equal(parsed.success, false);
});
