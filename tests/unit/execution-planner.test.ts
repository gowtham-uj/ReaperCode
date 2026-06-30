import test from "node:test";
import assert from "node:assert/strict";

import { classifyToolCall, ExecutionKind } from "../../src/execution/planner.js";
import type { ToolCall } from "../../src/tools/types.js";

function makeCall(name: ToolCall["name"], args: Record<string, unknown> = {}): ToolCall {
  return { id: "1", name, args } as ToolCall;
}

test("classifies complete_task as a shell barrier", () => {
  const result = classifyToolCall(makeCall("complete_task", { result: "done" }));
  assert.equal(result, "shell_barrier");
});

test("classifies delegate_to_plan and get_tool_output as read", () => {
  assert.equal(classifyToolCall(makeCall("delegate_to_plan", { mode: "initial" })), "read");
  assert.equal(classifyToolCall(makeCall("get_tool_output", { toolCallId: "1" })), "read");
});

test("classifies read tools as read", () => {
  assert.equal(classifyToolCall(makeCall("read_file", { path: "/tmp/foo" })), "read");
  assert.equal(classifyToolCall(makeCall("list_directory", { path: "/tmp" })), "read");
  assert.equal(classifyToolCall(makeCall("grep_search", { pattern: "foo" })), "read");
});

test("classifies write tools as write", () => {
  assert.equal(classifyToolCall(makeCall("write_file", { path: "/tmp/foo", content: "bar" })), "write");
  assert.equal(classifyToolCall(makeCall("replace_in_file", { path: "/tmp/foo", oldString: "a", newString: "b" })), "write");
  assert.equal(classifyToolCall(makeCall("delete_file", { path: "/tmp/foo" })), "write");
});

test("classifies run_shell_command according to barrier args and patterns", () => {
  assert.equal(classifyToolCall(makeCall("bash", { cmd: "npm install", barrier: false })), "shell_barrier");
  assert.equal(classifyToolCall(makeCall("bash", { cmd: "echo hi", forceNonBarrier: true })), "shell_non_barrier");
  assert.equal(classifyToolCall(makeCall("bash", { cmd: "echo hi", barrier: true })), "shell_barrier");
  assert.equal(classifyToolCall(makeCall("bash", { cmd: "echo hi" })), "shell_non_barrier");
});
