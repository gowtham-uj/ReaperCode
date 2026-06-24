import test from "node:test";
import assert from "node:assert/strict";

import {
  getToolKind,
  isCompletionTool,
  isControlTool,
  isExecutableTool,
  isMutatingTool,
  isSubagentTool,
} from "../../src/runtime/tool-taxonomy.js";

const requiredControlTools = [
  "update_task_contract",
  "update_plan",
  "update_todo",
  "call_subagent",
  "poll_subagent",
  "cancel_subagent",
  "complete_task",
  "create_checkpoint",
  "restore_checkpoint",
];

const requiredExecutableTools = [
  "inspect_project",
  "git_status",
  "git_diff",
  "read_file",
  "grep_search",
  "search_symbols",
  "list_package_scripts",
  "write_file",
  "replace_in_file",
  "edit_file",
  "apply_patch",
  "run_shell_command",
  "run_test_command",
  "read_test_failure_summary",
];

test("classifies every required control tool", () => {
  for (const toolName of requiredControlTools) {
    assert.equal(getToolKind(toolName), "control", toolName);
    assert.equal(isControlTool(toolName), true, toolName);
    assert.equal(isExecutableTool(toolName), false, toolName);
  }
});

test("classifies every required executable inspection or mutation tool", () => {
  for (const toolName of requiredExecutableTools) {
    assert.equal(getToolKind(toolName), "executable", toolName);
    assert.equal(isExecutableTool(toolName), true, toolName);
    assert.equal(isControlTool(toolName), false, toolName);
  }
});

test("detects mutating tools consistently across executable and control tools", () => {
  const mutatingTools = [
    "update_task_contract",
    "update_plan",
    "update_todo",
    "call_subagent",
    "cancel_subagent",
    "create_checkpoint",
    "restore_checkpoint",
    "write_file",
    "replace_in_file",
    "edit_file",
    "apply_patch",
    "run_shell_command",
  ];
  const inspectionTools = [
    "poll_subagent",
    "complete_task",
    "inspect_project",
    "git_status",
    "git_diff",
    "read_file",
    "grep_search",
    "search_symbols",
    "list_package_scripts",
    "run_test_command",
    "read_test_failure_summary",
  ];

  for (const toolName of mutatingTools) {
    assert.equal(isMutatingTool(toolName), true, toolName);
  }
  for (const toolName of inspectionTools) {
    assert.equal(isMutatingTool(toolName), false, toolName);
  }
});

test("detects completion and subagent tools", () => {
  assert.equal(isCompletionTool("complete_task"), true);
  assert.equal(isCompletionTool("update_plan"), false);

  assert.equal(isSubagentTool("call_subagent"), true);
  assert.equal(isSubagentTool("poll_subagent"), true);
  assert.equal(isSubagentTool("cancel_subagent"), true);
  assert.equal(isSubagentTool("read_file"), false);
});

test("unknown tools remain unknown", () => {
  assert.equal(getToolKind("not_a_real_tool"), "unknown");
  assert.equal(isControlTool("not_a_real_tool"), false);
  assert.equal(isExecutableTool("not_a_real_tool"), false);
  assert.equal(isMutatingTool("not_a_real_tool"), false);
});
