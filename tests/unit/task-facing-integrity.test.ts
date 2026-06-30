import test from "node:test";
import assert from "node:assert/strict";

import { getBuildChurnBlocker } from "../../src/runtime/task-facing-integrity.js";
import type { ToolResult } from "../../src/tools/types.js";

function shellCommand(id: string, cmd: string, ok = true): ToolResult {
  return {
    toolCallId: id,
    name: "bash",
    ok,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: ok ? 0 : 1, stdout: ok ? "ok" : "fail", stderr: "" },
    ...(ok ? {} : { error: { code: "command_failed", message: "build failed" } }),
  };
}

test("getBuildChurnBlocker returns undefined when build count is below threshold", () => {
  const results = [
    shellCommand("b1", "cmake --build build/", false),
    shellCommand("b2", "cmake --build build/", false),
  ];
  assert.equal(getBuildChurnBlocker(results, { maxAttempts: 3 }), undefined);
});

test("getBuildChurnBlocker blocks after threshold of failed build attempts", () => {
  const results = [
    shellCommand("b1", "cmake --build build/", false),
    shellCommand("b2", "cmake --build build/", false),
    shellCommand("b3", "cmake --build build/", false),
  ];
  const blocker = getBuildChurnBlocker(results, { maxAttempts: 3 });
  assert.match(blocker ?? "", /re-attempted 3 time\(s\)/);
  // The blocker must be language-agnostic: it should NOT name any specific
  // tool, language, or task. It should list categories of alternative fixes.
  assert.match(blocker ?? "", /\(a\)\s+install or upgrade/);
  assert.match(blocker ?? "", /\(b\)\s+change the build invocation flags/);
  assert.match(blocker ?? "", /\(c\)\s+change the toolchain entirely/);
  assert.match(blocker ?? "", /\(d\)\s+simplify the producer/);
  assert.match(blocker ?? "", /\(e\)\s+change the assumed data layout/);
  assert.match(blocker ?? "", /\(f\)\s+drop an optional feature/);
  assert.match(blocker ?? "", /\(g\)\s+re-read the spec/);
});

test("getBuildChurnBlocker counts across mixed build-system shapes", () => {
  // The blocker must fire regardless of which build system the agent chose.
  const results = [
    shellCommand("b1", "cmake --build .", false),
    shellCommand("b2", "make -C build", false),
    shellCommand("b3", "ninja -C build", false),
  ];
  const blocker = getBuildChurnBlocker(results, { maxAttempts: 3 });
  assert.match(blocker ?? "", /re-attempted 3 time\(s\)/);
});

test("getBuildChurnBlocker does not block when a producer execution succeeded in between", () => {
  const results = [
    shellCommand("b1", "cmake --build build/", false),
    shellCommand("p1", "./build/mdf2json MdfLib/test_models/foo.mdf converted_models/foo.json", true),
    shellCommand("b2", "cmake --build build/", false),
    shellCommand("b3", "cmake --build build/", false),
    shellCommand("b4", "cmake --build build/", false),
  ];
  assert.equal(getBuildChurnBlocker(results, { maxAttempts: 3 }), undefined);
});

test("getBuildChurnBlocker prescriptive body is task- and language-agnostic", () => {
  const results = [
    shellCommand("b1", "cmake --build .", false),
    shellCommand("b2", "cmake --build .", false),
    shellCommand("b3", "cmake --build .", false),
  ];
  const blocker = getBuildChurnBlocker(results) ?? "";
  // Strip the diagnostic header (which echoes the user's last command for
  // context) and assert that the prescriptive body of the message — the
  // portion that tells the agent what to do next — names no specific tool,
  // language, or task domain.
  const bodyStart = blocker.indexOf("Treat the build as");
  assert.notEqual(bodyStart, -1, "blocker must include prescriptive body");
  const body = blocker.slice(bodyStart);
  // The prescriptive body must use *categories* of fixes, not specific
  // tool/language names. It may mention the word "tool" / "runtime" /
  // "compiler" / "interpreter" only as a category, never as a specific
  // brand (e.g. cmake, gcc, g++, cargo, go, msvc, win32, struct-cast).
  assert.doesNotMatch(body, /\bcmake\b/i);
  assert.doesNotMatch(body, /\bg\+\+\b/i);
  assert.doesNotMatch(body, /\bgcc\b/i);
  assert.doesNotMatch(body, /\bcargo\b/i);
  assert.doesNotMatch(body, /\bgo build\b/i);
  assert.doesNotMatch(body, /\bninja\b/i);
  assert.doesNotMatch(body, /\bmake\b/i);
  assert.doesNotMatch(body, /\bMDF\b/);
  assert.doesNotMatch(body, /\bMdfLib\b/);
  assert.doesNotMatch(body, /\b3d\b/i);
  assert.doesNotMatch(body, /\bwin32\b/i);
  assert.doesNotMatch(body, /\bmsvc\b/i);
  assert.doesNotMatch(body, /\bstruct[-_ ]cast\b/i);
});
