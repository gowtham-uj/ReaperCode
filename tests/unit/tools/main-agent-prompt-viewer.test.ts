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
  assert.match(prompt, /file_find/);
  // The prompt names only tools that exist. `file_scroll` was folded into
  // `file_view`, and a prompt that still teaches it would send the model after
  // a name it can only reach through the alias map.
  assert.doesNotMatch(prompt, /file_scroll/);
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
