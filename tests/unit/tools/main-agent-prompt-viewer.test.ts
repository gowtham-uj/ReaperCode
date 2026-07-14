/**
 * System prompt edit-path contract: lean preferred path with canonical tools.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

test("system prompt renders Preferred Edit Path with canonical tools", async () => {
  const { buildMainAgentSystemPrompt } = await import("../../../src/runtime/system-prompt.js");
  const prompt = buildMainAgentSystemPrompt({});
  assert.match(prompt, /Preferred edit path/i);
  assert.match(prompt, /1\. file_view/);
  assert.match(prompt, /file_scroll/);
  assert.match(prompt, /file_find/);
  assert.match(prompt, /2\. file_edit/);
  assert.match(prompt, /3\. write_file/);
  assert.match(prompt, /4\. bash/);
  assert.doesNotMatch(prompt, /\bscratchpad\b/i);
});

test("system prompt directs the model to line-numbered file_edit", async () => {
  const { buildMainAgentSystemPrompt } = await import("../../../src/runtime/system-prompt.js");
  const prompt = buildMainAgentSystemPrompt({});
  assert.match(prompt, /file_view/);
  assert.match(prompt, /file_edit/);
  assert.match(prompt, /auto-lints/i);
});
