import test from "node:test";
import assert from "node:assert/strict";

import { normalizeToolResult, renderNormalizedToolResultForModel } from "../../src/tools/tool-result.js";

test("normalizeToolResult separates model summary from structured details", () => {
  const normalized = normalizeToolResult({
    ok: true,
    toolCallId: "call-1",
    name: "file_view",
    args: { path: "src/big.ts" },
    durationMs: 7,
    output: JSON.stringify({ kind: "file_view", path: "src/big.ts", totalLines: 1200, window: ["1|const x = 1;", "2|export { x };"] }),
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.name, "file_view");
  assert.equal(normalized.details?.kind, "json");
  assert.equal(normalized.details?.summary, "file_view ok: src/big.ts");
  assert.equal(normalized.meta?.safeToPrune, true);
  assert.equal(normalized.meta?.pruneReplacement, "[file_view: completed, 104 bytes]");
  assert.deepEqual(renderNormalizedToolResultForModel(normalized), {
    ok: true,
    summary: "file_view ok: src/big.ts",
    content: JSON.stringify({ kind: "file_view", path: "src/big.ts", totalLines: 1200, window: ["1|const x = 1;", "2|export { x };"] }),
  });
});

test("normalizeToolResult preserves errors and marks them unsafe to prune", () => {
  const normalized = normalizeToolResult({
    ok: false,
    toolCallId: "call-2",
    name: "bash",
    args: { cmd: "pnpm test" },
    durationMs: 50,
    output: "",
    error: { code: "exit_1", message: "tests failed" },
  });

  assert.equal(normalized.isError, true);
  assert.equal(normalized.details?.kind, "none");
  assert.equal(normalized.meta?.safeToPrune, false);
  assert.deepEqual(normalized.diagnostics, [{ severity: "error", source: "bash", message: "tests failed" }]);
  assert.deepEqual(renderNormalizedToolResultForModel(normalized), {
    ok: false,
    summary: "bash failed: tests failed",
    error: { code: "exit_1", message: "tests failed" },
  });
});
