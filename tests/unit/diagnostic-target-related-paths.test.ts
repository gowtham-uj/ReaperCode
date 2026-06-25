import test from "node:test";
import assert from "node:assert/strict";

/**
 * The diagnostic target gate and the relevance gate used to block any
 * mutation of the implementation file when the only file mentioned in a
 * failing test runner output was the test file. The implementation
 * imported by the failing test is a legitimate fix target, so the gates
 * must allow it. These tests pin the helper logic that powers the
 * expansion.
 */

import { isTestFilePath, expandDiagnosticTargetRelatedPaths } from "../../src/runtime/engine.js";
import type { ToolResult } from "../../src/tools/types.js";

test("isTestFilePath recognizes common test naming patterns", () => {
  assert.equal(isTestFilePath("isPalindrome.test.js"), true);
  assert.equal(isTestFilePath("src/foo/bar.spec.ts"), true);
  assert.equal(isTestFilePath("tests/test_foo.py"), true);
  assert.equal(isTestFilePath("foo_test.py"), true);
  assert.equal(isTestFilePath("foo_test.go"), true);
  assert.equal(isTestFilePath("isPalindrome.js"), false);
  assert.equal(isTestFilePath("src/index.ts"), false);
  assert.equal(isTestFilePath("_test_helper.go"), false);
});

test("expandDiagnosticTargetRelatedPaths returns the implementation under test", () => {
  const result: ToolResult = {
    toolCallId: "tc-1",
    name: "run_shell_command",
    ok: false,
    durationMs: 0,
    error: {
      code: "tool_error",
      message: [
        "TAP version 13",
        "not ok 1 - palindrome detection",
        "  location: '/tmp/reaper-stress-target/isPalindrome.test.js:5:1'",
        "  at TestContext.<anonymous> (file:///tmp/reaper-stress-target/isPalindrome.test.js:6:10)",
        "    at Test.processPendingSubtests (node:internal/test_runner/test:526:18)",
      ].join("\n"),
    },
  };
  const related = expandDiagnosticTargetRelatedPaths("isPalindrome.test.js", result);
  assert.ok(
    related.some((p) => p.endsWith("isPalindrome.js")),
    `expected related paths to include isPalindrome.js, got: ${related.join(", ")}`,
  );
});

test("expandDiagnosticTargetRelatedPaths follows explicit imports in failure text", () => {
  const result: ToolResult = {
    toolCallId: "tc-2",
    name: "run_shell_command",
    ok: false,
    durationMs: 0,
    error: {
      code: "tool_error",
      message: 'import { foo } from "./utils/bar.js" failed',
    },
  };
  const related = expandDiagnosticTargetRelatedPaths("foo.test.js", result);
  assert.ok(
    related.some((p) => p.includes("utils/bar.js")),
    `expected related paths to include utils/bar.js, got: ${related.join(", ")}`,
  );
});

test("expandDiagnosticTargetRelatedPaths is empty for non-test paths", () => {
  const result: ToolResult = {
    toolCallId: "tc-3",
    name: "run_shell_command",
    ok: false,
    durationMs: 0,
    error: { code: "tool_error", message: "boom" },
  };
  const related = expandDiagnosticTargetRelatedPaths("src/index.ts", result);
  assert.equal(related.length, 0);
});
