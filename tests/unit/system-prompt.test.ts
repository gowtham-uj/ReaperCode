import test from "node:test";
import assert from "node:assert/strict";

import { MAIN_AGENT_SYSTEM_PROMPT_TEXT, buildMainAgentSystemPrompt } from "../../src/runtime/system-prompt.js";


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

test("main-agent system prompt ignores dynamic tool inventory", () => {
  const system = buildMainAgentSystemPrompt({}, {
    availableTools: [{ name: "read_file" }, { name: "bash" }],
  });
  assert.equal(system, MAIN_AGENT_SYSTEM_PROMPT_TEXT);
  assert.doesNotMatch(system, /# Tool inventory/);
  assert.doesNotMatch(system, /^- read_file$/m);
});

test("main-agent system prompt ignores tool descriptions", () => {
  const longDescription = "word ".repeat(120);
  const system = buildMainAgentSystemPrompt({}, {
    availableTools: [{ name: "very_verbose_tool", description: longDescription }],
  });
  assert.equal(system, MAIN_AGENT_SYSTEM_PROMPT_TEXT);
  assert.doesNotMatch(system, /very_verbose_tool|word word word/);
});


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
