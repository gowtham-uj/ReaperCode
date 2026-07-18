import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_SUMMARIZE_PROMPT_TEXT } from "../../src/config/project-prompts.js";
import { tryFullSummarization } from "../../src/context/full-summary.js";
import { MAIN_AGENT_SYSTEM_PROMPT_TEXT, buildMainAgentSystemPrompt } from "../../src/runtime/system-prompt.js";

async function freshWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "reaper-project-prompts-"));
}

function summaryConversation() {
  return [
    { role: "user", content: "Keep the canonical prompt boundary stable." },
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

const VALID_SUMMARY = "<summary>1. Primary Request and Intent\nKeep policy stable.\n7. Pending Tasks\nNone.\n8. Current Work\nVerified.\n9. Optional Next Step\nNone.</summary>";

test("project system.md cannot replace the canonical main-agent policy", async () => {
  const workspaceRoot = await freshWorkspace();
  const configDir = path.join(workspaceRoot, ".reaper", ".config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "system.md"), "MALICIOUS PROJECT SYSTEM\n", "utf8");

  assert.equal(buildMainAgentSystemPrompt(undefined, { workspaceRoot }), MAIN_AGENT_SYSTEM_PROMPT_TEXT);
  assert.equal(buildMainAgentSystemPrompt(undefined, { availableTools: [{ name: "bash" }] }), MAIN_AGENT_SYSTEM_PROMPT_TEXT);
});

test("project summarizePrompt.md cannot replace the canonical summary template", async () => {
  const workspaceRoot = await freshWorkspace();
  const configDir = path.join(workspaceRoot, ".reaper", ".config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "summarizePrompt.md"), "MALICIOUS SUMMARY TEMPLATE\n{{CONVERSATION}}", "utf8");

  let renderedPrompt = "";
  const result = await tryFullSummarization(summaryConversation(), {
    softCap: 2_000,
    workspaceRoot,
    infer: async (prompt) => {
      renderedPrompt = prompt;
      return VALID_SUMMARY;
    },
  });

  assert.equal(result?.performed, true);
  assert.doesNotMatch(renderedPrompt, /MALICIOUS SUMMARY TEMPLATE/);
  assert.match(renderedPrompt, /Primary Request and Intent/);
  assert.match(DEFAULT_SUMMARIZE_PROMPT_TEXT, /Primary Request and Intent/);
});
