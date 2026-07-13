import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMainAgentCockpit,
  buildMainAgentSystemPrompt,
} from "../../src/runtime/main-agent-prompt.js";
import { buildGeneralAgentTools } from "../../src/runtime/agent-tools.js";

test("main-agent cockpit includes required OMP-aligned sections", () => {
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
    "Budget",
  ]) {
    assert.match(cockpit, new RegExp(`## ${escapeRegExp(section)}`));
  }

  assert.match(cockpit, /Implement Part 8/);
  // Tool inventory moved to system prompt (OMP toolListMode); not in cockpit.
  assert.doesNotMatch(cockpit, /## Available Tools/);
  assert.doesNotMatch(cockpit, /## Verification State/);
  assert.doesNotMatch(cockpit, /## Tool Shortlist/);
});

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

test("main-agent system prompt lists tools without long descriptions", () => {
  const longDescription = "word ".repeat(120);
  const system = buildMainAgentSystemPrompt({}, {
    availableTools: [{ name: "very_verbose_tool", description: longDescription }],
  });

  assert.match(system, /- very_verbose_tool\b/);
  // Descriptions are omitted from system inventory (API tools[] carries schemas).
  assert.doesNotMatch(system, /word word word/);
});

test("main-agent cockpit renders prepared context compactly without tool shortlist", () => {
  const longDescription = "Read a file from disk with many details. ".repeat(20);
  const cockpit = buildMainAgentCockpit(
    {
      contentPrep: {
        preparedContext: {
          fingerprint: "fp-1",
          fileTree: ["package.json", "README.md", "src/index.js"],
          chunks: [
            {
              path: "package.json",
              score: 0.98765,
              reason: "manifest and test command",
              content: 'FILE: package.json\n{"type":"module","scripts":{"test":"node --test"}}',
            },
            {
              path: "README.md",
              score: 0.75,
              reason: "task instructions",
              content: "FILE: README.md\n# Task\nImplement src/index.js",
            },
          ],
        },
        toolShortlist: [{ name: "read_file", score: 0.91, description: longDescription }],
      },
    },
    { payload: { prompt: "Implement the module" } },
    undefined,
    undefined,
    undefined,
    undefined,
  );

  assert.match(cockpit, /files \(3\): package\.json, README\.md, src\/index\.js/);
  assert.match(cockpit, /--- package\.json score=0\.988 reason=manifest and test command/);
  assert.match(cockpit, /node --test/);
  assert.doesNotMatch(cockpit, /## Tool Shortlist/);
  assert.doesNotMatch(cockpit, /- read_file \[0\.91\]/);
  assert.doesNotMatch(cockpit, /\"fileTree\"/);
  assert.doesNotMatch(cockpit, /\"toolShortlist\"/);
  assert.doesNotMatch(cockpit, /\"description\"/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
