import test from "node:test";
import assert from "node:assert/strict";

import { buildDescriptorsFromRegistry, resetDescriptors } from "../../src/tools/descriptor-builder.js";
import { getToolDescriptor } from "../../src/tools/descriptor.js";
import { isKnownToolName } from "../../src/tools/tool-allowlist.js";
import { CORE_TOOL_NAMES, ON_DEMAND_TOOL_NAMES, toolRegistry } from "../../src/tools/registry.js";
import { normalizeToolCall } from "../../src/tools/normalize.js";

const STALE_TOOLS = [
  "complete_task",
  "advance_step",
  "delegate_to_plan",
  "cancel_subagent",
  "call_subagent",
  "poll_subagent",
  "agent",
  "agent_swarm",
  "task_create",
  "task_update",
  "task_list",
  "update_plan",
  "update_todo",
  "run_command",
  "run_shell_command",
  "sandbox_service_control",
];

test("retired planner, task, and shell tools are not registered or discoverable", () => {
  resetDescriptors();
  buildDescriptorsFromRegistry();

  for (const name of STALE_TOOLS) {
    assert.equal(name in toolRegistry, false, `${name} must not be in toolRegistry`);
    assert.equal(CORE_TOOL_NAMES.has(name), false, `${name} must not be core`);
    assert.equal(ON_DEMAND_TOOL_NAMES.has(name), false, `${name} must not be on-demand`);
    assert.equal(getToolDescriptor(name), undefined, `${name} must not have a descriptor`);
    assert.equal(isKnownToolName(name), false, `${name} must not be accepted by allowlist`);
  }

  resetDescriptors();
});

test("normalization does not alias natural finish words to removed complete_task", () => {
  const finish = normalizeToolCall({ id: "finish-1", name: "finish", args: { summary: "done" } }) as { name: string };
  const complete = normalizeToolCall({ id: "complete-1", name: "complete", args: { summary: "done" } }) as { name: string };
  assert.equal(finish.name, "finish");
  assert.equal(complete.name, "complete");
});

test("normalization does not alias retired shell names to bash", () => {
  for (const name of ["run_command", "run_shell_command", "sandbox_service_control"]) {
    const normalized = normalizeToolCall({ id: name, name, args: { cmd: "true" } }) as { name: string };
    assert.equal(normalized.name, name);
  }
});
