import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../../src/tools/types.js";

test("ToolCallSchema accepts file_edit with optional reason metadata", () => {
  const call = {
    id: "f1",
    name: "file_edit",
    args: {
      path: "packages/shared/src/schemas.ts",
      start_line: 35,
      end_line: 35,
      new_content: "x",
      reason: "Fix TS18046",
    },
  };
  const r = ToolCallSchema.safeParse(call);
  assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
});

test("ToolCallSchema rejects file_edit with start_line > end_line even with reason", () => {
  const call = {
    id: "f2",
    name: "file_edit",
    args: { path: "a.ts", start_line: 50, end_line: 10, new_content: "x", reason: "fix" },
  };
  const r = ToolCallSchema.safeParse(call);
  assert.equal(r.success, false);
});