import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCrashDiagnosticFeedback,
  hasUnresolvedRuntimeCrash,
  isCrashDiagnosticToolCall,
} from "../../src/runtime/crash-diagnostics.js";
import type { ToolCall, ToolResult } from "../../src/tools/types.js";

test("unresolved runtime crash opens diagnostic mode until a real runtime check passes", () => {
  const crash = shellResult("crash", false, "./build/tool input", "", "Segmentation fault (core dumped)", 139);
  assert.equal(hasUnresolvedRuntimeCrash([crash]), true);
  assert.match(buildCrashDiagnosticFeedback([crash]) ?? "", /Crash diagnostic mode/i);

  const warningBuild = shellResult("warning-build", true, "cmake --build build", "warning: old API", "", 0);
  assert.equal(hasUnresolvedRuntimeCrash([crash, warningBuild]), true);

  const runtimePass = shellResult("runtime-pass", true, "./build/tool input", "ok", "", 0);
  assert.equal(hasUnresolvedRuntimeCrash([crash, warningBuild, runtimePass]), false);
});

test("crash diagnostics recognize debugger, sanitizer, layout, and read-only probes", () => {
  const calls: ToolCall[] = [
    { id: "asan", name: "bash", args: { cmd: "clang++ -g -fsanitize=address main.cpp", timeout: 30 } },
    { id: "gdb", name: "bash", args: { cmd: "gdb -batch -ex bt ./app", timeout: 30 } },
    { id: "layout", name: "bash", args: { cmd: "printf 'sizeof record' && ./layout_probe", timeout: 30 } },
    { id: "read", name: "read_file", args: { path: "src/main.cpp" } },
  ];

  assert.equal(calls.every(isCrashDiagnosticToolCall), true);
  assert.equal(isCrashDiagnosticToolCall({ id: "edit", name: "write_file", args: { path: "src/main.cpp", content: "" } }), false);
});

function shellResult(
  id: string,
  ok: boolean,
  cmd: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): ToolResult {
  return {
    toolCallId: id,
    name: "bash",
    ok,
    durationMs: 1,
    args: { cmd },
    output: { stdout, stderr, exitCode },
    ...(ok ? {} : { error: { code: "tool_error", message: stderr } }),
  };
}
