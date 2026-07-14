import test from "node:test";
import assert from "node:assert/strict";

import { buildMainAgentSystemPrompt } from "../../src/runtime/system-prompt.js";
import { buildGeneralAgentTools } from "../../src/runtime/agent-tools.js";


test("main-agent system prompt includes required requirements text", () => {
  const system = buildMainAgentSystemPrompt({});

  for (const requiredText of [
    "You are Reaper's main agent.",
    "You own the task from user request to verified completion",
    "Response and STOP",
    "no tool_calls",
    "Edit path",
    "file_view",
    "file_edit",
    "Trust",
    "Delivery contract",
    "Reasoning discipline",
    "NEVER prefix the workspace directory",
    "NEVER rationalize a mismatch",
  ]) {
    assert.match(system, new RegExp(escapeRegExp(requiredText), "i"));
  }
  assert.doesNotMatch(system, /\bscratchpad\b/i);
  assert.doesNotMatch(system, /Main Agent Cockpit|cockpit memory/i);
});

test("main-agent system prompt includes compact tool inventory when provided", () => {
  const system = buildMainAgentSystemPrompt({}, {
    availableTools: [{ name: "read_file" }, { name: "bash" }],
  });
  assert.match(system, /# Tool inventory/);
  assert.match(system, /- read_file\b/);
  assert.match(system, /- bash\b/);
});

test("main-agent system inventory exactly mirrors the offered API tools", () => {
  const offered = buildGeneralAgentTools();
  const system = buildMainAgentSystemPrompt({}, { availableTools: offered });
  const inventory = system
    .split("# Tool inventory\n")[1]!
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

  assert.deepEqual(inventory, offered.map((tool) => tool.name));
  assert.doesNotMatch(system, /\b(?:run_command|run_shell_command|sandbox_service_control)\b/);
});


test("main-agent system prompt lists tools without long descriptions", () => {
  const longDescription = "word ".repeat(120);
  const system = buildMainAgentSystemPrompt({}, {
    availableTools: [{ name: "very_verbose_tool", description: longDescription }],
  });

  assert.match(system, /- very_verbose_tool\b/);
  // Descriptions are omitted from system inventory (API tools[] carries schemas).
  assert.doesNotMatch(system, /word word word/);
});


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
