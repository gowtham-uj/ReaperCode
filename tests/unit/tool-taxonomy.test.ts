import test from "node:test";
import assert from "node:assert/strict";

import {
  getToolKind,
  isControlTool,
  isExecutableTool,
  isMutatingTool,
} from "../../src/runtime/tool-taxonomy.js";

const requiredControlTools = [
  "update_task_contract",
  "update_plan",
  "update_todo",
  "create_checkpoint",
  "restore_checkpoint",
];

const requiredExecutableTools = [
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
  "bash",
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
    "create_checkpoint",
    "restore_checkpoint",
    "write_file",
    "replace_in_file",
    "edit_file",
    "apply_patch",
    "bash",
  ];
  const inspectionTools = [
    "update_plan",
    "update_todo",
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


test("unknown tools remain unknown", () => {
  assert.equal(getToolKind("not_a_real_tool"), "unknown");
  assert.equal(isControlTool("not_a_real_tool"), false);
  assert.equal(isExecutableTool("not_a_real_tool"), false);
  assert.equal(isMutatingTool("not_a_real_tool"), false);
});

test("removed request_patch legacy route is not classified as a control tool", () => {
  assert.equal(getToolKind("request_patch"), "unknown");
  assert.equal(isControlTool("request_patch"), false);
  assert.equal(isExecutableTool("request_patch"), false);
  assert.equal(isMutatingTool("request_patch"), false);
});
