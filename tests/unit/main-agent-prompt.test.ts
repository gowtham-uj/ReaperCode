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

test("main-agent cockpit compacts long tool history instead of replaying full file contents", () => {
  const longContent = "0123456789".repeat(500);
  const toolResults = Array.from({ length: 12 }, (_, index) => ({
    toolCallId: `call-${index}`,
    name: "read_file",
    ok: true,
    durationMs: 1,
    args: { path: `src/file-${index}.ts` },
    output: {
      path: `src/file-${index}.ts`,
      startLine: 1,
      endLine: 20,
      totalLines: 20,
      content: `${longContent}-${index}`,
    },
  }));

  const cockpit = buildMainAgentCockpit(
    { recentToolResults: toolResults },
    { payload: { prompt: "Improve context handling" } },
    undefined,
    undefined,
    undefined,
    undefined,
  );

  assert.match(cockpit, /totalResults/);
  assert.match(cockpit, /retainedResults/);
  assert.match(cockpit, /outputCompactedForModel/);
  assert.doesNotMatch(cockpit, new RegExp(escapeRegExp(longContent)));
});

test("main-agent cockpit caps long tool descriptions", () => {
  const longDescription = "word ".repeat(120);
  const cockpit = buildMainAgentCockpit(
    {},
    { payload: { prompt: "Use tools" } },
    undefined,
    undefined,
    undefined,
    undefined,
    { availableTools: [{ name: "very_verbose_tool", description: longDescription }] },
  );

  assert.match(cockpit, /very_verbose_tool/);
  assert.match(cockpit, /\[truncated\]/);
  assert.ok(cockpit.length < longDescription.length + 1200);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
