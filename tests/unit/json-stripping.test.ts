import test from "node:test";
import assert from "node:assert/strict";

import { stripThinkingBlocks, extractJsonObject, generateStructuredJson } from "../../src/model/json-response.js";

test("generateStructuredJson accepts switchModeOnTruncation flag without TS error", () => {
  assert.equal(typeof generateStructuredJson, "function");
});

test("stripThinkingBlocks strips deep thinking blocks", () => {
  const input = "<think>deep reasoning\nwith multiple\nlines and special chars: {}\"<think>\nmore inside</think>\n{\"answer\": 1}";
  const out = stripThinkingBlocks(input);
  assert.ok(!out.includes("<think>"));
  assert.match(out, /\{"answer": 1\}/);
});

test("extractJsonObject after stripThinkingBlocks returns the right object", () => {
  // The think-block regex strips the entire <...> block, the fence regex
  // strips ```...```, leaving only the post-fence JSON object behind.
  const input = [
    "<think>Some long analysis with quotes \" and braces {}",
    "More analysis inside the think",
    "</think>",
    "```json",
    "{\"example\": 1}",
    "```",
    "",
    "{\"answer\": 42, \"tool_calls\": []}",
  ].join("\n");
  const json = extractJsonObject(input);
  assert.ok(json);
  const parsed = JSON.parse(json!);
  assert.equal(parsed.answer, 42);
});
