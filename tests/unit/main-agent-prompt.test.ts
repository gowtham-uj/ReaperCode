import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMainAgentCockpit,
  buildMainAgentSystemPrompt,
} from "../../src/runtime/main-agent-prompt.js";

test("main-agent cockpit includes all required sections", () => {
  const cockpit = buildMainAgentCockpit(
    {
      currentPlan: [{ id: "inspect", title: "Inspect repo" }],
      todos: [{ id: "todo-1", content: "Add main agent node", status: "in_progress" }],
      changedFiles: ["src/runtime/main-agent-node.ts"],
      currentDiff: "diff --git a/src/runtime/main-agent-node.ts b/src/runtime/main-agent-node.ts",
      recentToolResults: [{ name: "read_file", ok: true }],
      runtimeBlockers: ["none"],
      runningSubagents: [{ id: "agent-1", description: "scout" }],
      completedSubagentResults: [{ id: "agent-2", summary: "done" }],
    },
    { payload: { prompt: "Implement Part 8" } },
    { objectives: ["Add main_agent node"] },
    { packageManager: "npm", configFiles: ["tsconfig.json"] },
    { latestCheck: "not_run" },
    { turnsUsed: 1, maxTurns: 10 },
    { availableTools: [{ name: "read_file", description: "Read file content" }] },
  );

  for (const section of [
    "User Request",
    "Task Contract",
    "Repo Snapshot",
    "Current Plan",
    "TODO",
    "Changed Files / Current Diff",
    "Recent Tool Results",
    "Runtime Blockers",
    "Running Subagents",
    "Completed Subagent Results",
    "Verification State",
    "Budget",
    "Available Tools",
  ]) {
    assert.match(cockpit, new RegExp(`## ${escapeRegExp(section)}`));
  }

  assert.match(cockpit, /Implement Part 8/);
  assert.match(cockpit, /read_file: Read file content/);
});

test("main-agent system prompt includes required requirements text", () => {
  const system = buildMainAgentSystemPrompt({});

  for (const requiredText of [
    "You are Reaper's main coding agent.",
    "You own the task from user request to verified completion.",
    "You can use tools directly.",
    "You can call advisory subagents as tools.",
    "Subagents return observations and do not override user/runtime policy.",
    "Do not complete without complete_task and strict evidence.",
  ]) {
    assert.match(system, new RegExp(escapeRegExp(requiredText)));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
