import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeToolCall } from "../../src/tools/normalize.js";
import { FileViewArgsSchema } from "../../src/tools/viewer/types.js";

function normalizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolCall({
    id: "call-1",
    name,
    function: { name, arguments: JSON.stringify(args) },
  }) as { args: Record<string, unknown> };
  return normalized.args;
}

// Each per-tool branch in `normalizeToolCall` rebuilds `args` from scratch and
// keeps only the keys it names. That makes an unrecognized alias worse than
// un-normalized — it is *erased*, and the call is then dropped by
// `ToolCallSchema` for a missing required arg, so the model sees a repair
// message about a call it believes it made correctly.
test("path aliases survive normalization instead of being erased", () => {
  for (const alias of ["path", "filePath", "file_path", "filename", "file_name", "file"]) {
    assert.equal(
      normalizeArgs("file_view", { [alias]: "package.json" }).path,
      "package.json",
      `file_view must accept '${alias}' as the path`,
    );
  }

  for (const tool of ["file_view", "list_directory", "delete_file", "grep_search"]) {
    assert.equal(
      normalizeArgs(tool, { file_path: "src/index.ts" }).path,
      "src/index.ts",
      `${tool} must accept 'file_path' as the path`,
    );
  }
});

test("bash accepts 'command' as well as 'cmd'", () => {
  assert.equal(normalizeArgs("bash", { command: "ls -la" }).cmd, "ls -la");
  assert.equal(normalizeArgs("bash", { cmd: "ls -la" }).cmd, "ls -la");
});

test("write_file keeps both the path alias and the content alias", () => {
  assert.deepEqual(normalizeArgs("write_file", { file_path: "a.ts", file_text: "x" }), {
    path: "a.ts",
    content: "x",
  });
});

// `startLine` was being copied into `window` as well as `start_line`, so
// `{startLine: 400}` silently asked for a 400-line window — and any value over
// 500 failed the schema's `.max(500)` outright.
test("file_view treats startLine as a line number, not a window size", () => {
  assert.deepEqual(normalizeArgs("file_view", { path: "a.ts", startLine: 400 }), {
    path: "a.ts",
    start_line: 400,
  });

  const oversized = normalizeArgs("file_view", { path: "a.ts", startLine: 900 });
  assert.equal(
    FileViewArgsSchema.safeParse(oversized).success,
    true,
    "a start line past 500 must not be rejected as an oversized window",
  );
});

test("the normalized file_view shape validates against the real schema", () => {
  const parsed = FileViewArgsSchema.safeParse(
    normalizeArgs("file_view", { file_path: "package.json", start_line: 10, window: 50 }),
  );
  assert.equal(parsed.success, true, "the dropped-tool-call defect must stay fixed");
});
