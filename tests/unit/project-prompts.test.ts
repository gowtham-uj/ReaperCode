import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { tryFullSummarization } from "../../src/context/full-summary.js";
import { buildMainAgentSystemPrompt } from "../../src/runtime/system-prompt.js";

async function freshWorkspace(t: test.TestContext): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-project-prompts-"));
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  return workspaceRoot;
}

function summaryConversation() {
  return [
    { role: "user", content: "Keep project prompt behavior configurable." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "prompt-output",
        function: { name: "bash", arguments: JSON.stringify({ cmd: "generate-output" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "prompt-output",
      name: "bash",
      content: "x".repeat(20_000),
    },
  ];
}

const VALID_SUMMARY = "<summary>1. Primary Request and Intent\nKeep prompts configurable.\n7. Pending Tasks\nNone.\n8. Current Work\nVerified.\n9. Optional Next Step\nNone.</summary>";

function customSummaryTemplate(marker: string): string {
  return [
    marker,
    "{{MODE_INSTRUCTIONS}}",
    "{{CHECKPOINT_SECTION}}",
    "{{PRIOR_SUMMARY_SECTION}}",
    "{{CONVERSATION}}",
    "{{RETRY_SECTION}}",
    "{{PREVIOUS_ATTEMPT_SECTION}}",
  ].join("\n");
}

test("system prompt files are seeded and reloaded between runs", async (t) => {
  const workspaceRoot = await freshWorkspace(t);
  const configDir = path.join(workspaceRoot, ".reaper", ".config");
  const systemPath = path.join(configDir, "system.md");
  const summarizePath = path.join(configDir, "summarizePrompt.md");

  const initial = buildMainAgentSystemPrompt(undefined, { workspaceRoot });
  assert.match(initial, /You are Reaper's main agent/);
  assert.match(await readFile(systemPath, "utf8"), /Delivery contract/);
  assert.match(await readFile(summarizePath, "utf8"), /Primary Request and Intent/);

  await writeFile(systemPath, "CUSTOM SYSTEM PROMPT V1\n", "utf8");
  const firstReload = buildMainAgentSystemPrompt(undefined, { workspaceRoot });
  assert.equal(firstReload, "CUSTOM SYSTEM PROMPT V1");

  await writeFile(systemPath, "CUSTOM SYSTEM PROMPT V2\n", "utf8");
  const secondReload = buildMainAgentSystemPrompt(undefined, { workspaceRoot });
  assert.equal(secondReload, "CUSTOM SYSTEM PROMPT V2");
});

test("summarizer prompt is reloaded for every compaction", async (t) => {
  const workspaceRoot = await freshWorkspace(t);
  buildMainAgentSystemPrompt(undefined, { workspaceRoot });
  const summarizePath = path.join(workspaceRoot, ".reaper", ".config", "summarizePrompt.md");

  await writeFile(summarizePath, customSummaryTemplate("CUSTOM SUMMARY V1"), "utf8");
  let firstPrompt = "";
  const first = await tryFullSummarization(summaryConversation(), {
    softCap: 2_000,
    workspaceRoot,
    infer: async (prompt) => {
      firstPrompt = prompt;
      return VALID_SUMMARY;
    },
  });
  assert.equal(first?.performed, true);
  assert.match(firstPrompt, /CUSTOM SUMMARY V1/);

  await writeFile(summarizePath, customSummaryTemplate("CUSTOM SUMMARY V2"), "utf8");
  let secondPrompt = "";
  const second = await tryFullSummarization(summaryConversation(), {
    softCap: 2_000,
    workspaceRoot,
    infer: async (prompt) => {
      secondPrompt = prompt;
      return VALID_SUMMARY;
    },
  });
  assert.equal(second?.performed, true);
  assert.match(secondPrompt, /CUSTOM SUMMARY V2/);
  assert.doesNotMatch(secondPrompt, /CUSTOM SUMMARY V1/);
});
