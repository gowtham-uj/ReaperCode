/**
 * Phase-4: verify the runtime system prompt renders the
 * "Preferred Edit Path" advisory block with the six ordered items.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

test("Phase 4: system prompt renders the six-item Preferred Edit Path block", async () => {
  const { buildMainAgentSystemPrompt } = await import("../../../src/runtime/main-agent-prompt.js");
  const prompt = buildMainAgentSystemPrompt({});
  assert.match(prompt, /PREFERRED EDIT PATH/);
  assert.match(prompt, /Preferred edit path/i);
  // Six numbered items
  assert.match(prompt, /1\. file_view/);
  assert.match(prompt, /2\. file_scroll \| file_find/);
  assert.match(prompt, /3\. file_edit/);
  assert.match(prompt, /4\. write_file/);
  assert.match(prompt, /5\. bash/);
  assert.match(prompt, /6\. read_file, replace_in_file, view_file/);
  assert.match(prompt, /legacy on-demand tools/);
});

test("Phase 4: TOOL USE HINTS directs the model to line-numbered file_edit", async () => {
  const { buildMainAgentSystemPrompt } = await import("../../../src/runtime/main-agent-prompt.js");
  const prompt = buildMainAgentSystemPrompt({});
  assert.match(prompt, /file_view\/file_find\/file_scroll/i);
  assert.match(prompt, /use file_edit/i);
  assert.match(prompt, /auto-lints/i);
  assert.match(prompt, /atomic/i);
});
