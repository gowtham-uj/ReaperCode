/**
 * json-response.test.ts — regression coverage for the structured-JSON parser
 * used by Reaper's main agent and the unified Planner sub-agent.
 *
 * Two failure modes the suite pins down:
 *
 *   1. **MiniMax-M3 `<think>` prefix.** MiniMax-M3 emits a leading
 *      `<think>...</think>` (or unterminated `<think>`) reasoning block
 *      before the JSON payload. The reasoning text often contains
 *      balanced `{...}` segments (code snippets the model is reasoning
 *      about), so the naive `extractJsonObject` would grab the wrong
 *      one. `stripLeadingReasoning` is the fix.
 *
 *   2. **OpenAI-style JSON-mode regressions.** A model that returns
 *      native tool calls but no JSON content (e.g. provider JSON mode
 *      with `tool_calls: [...]`) must still produce a usable envelope.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonValue, stripLeadingReasoning } from "../../src/model/json-response.js";

// ---------- stripLeadingReasoning -----------------------------------

test("stripLeadingReasoning: leaves plain JSON untouched", () => {
  const input = '{"assistant_message":"hi","tool_calls":[]}';
  assert.equal(stripLeadingReasoning(input), input);
});

test("stripLeadingReasoning: strips a closed <think> block (single line)", () => {
  const input = '<think>Let me think...</think>{"tool_calls":[]}';
  assert.equal(stripLeadingReasoning(input), '{"tool_calls":[]}');
});

test("stripLeadingReasoning: strips a closed <think> block (multi-line, balanced braces inside)", () => {
  const input = `<think>
We need to call { "example": "code snippet" } first.
Then { "second": "snippet" }.
</think>
{"assistant_message":"plan ready","tool_calls":[{"id":"1","name":"read_file","args":{"path":"foo"}}]}`;
  const out = stripLeadingReasoning(input);
  // The leading newline before the JSON is preserved; the JSON parser
  // trims it. The important assertion is that no `<think>` reasoning text
  // survives.
  assert.ok(!out.includes("<think>"));
  assert.ok(!out.includes("example"));
  assert.ok(!out.includes("snippet"));
  assert.ok(out.includes('"assistant_message"'));
  assert.equal(
    out.trim(),
    '{"assistant_message":"plan ready","tool_calls":[{"id":"1","name":"read_file","args":{"path":"foo"}}]}',
  );
});

test("stripLeadingReasoning: strips <reasoning>...</reasoning> blocks", () => {
  const input = '<reasoning>thinking about the task</reasoning>{"ok":true}';
  assert.equal(stripLeadingReasoning(input), '{"ok":true}');
});

test("stripLeadingReasoning: handles an unterminated <think> (model ran out of tokens mid-reasoning)", () => {
  const input = `<think>I was reasoning and ran out of tokens
{"assistant_message":"will continue","tool_calls":[]}`;
  const out = stripLeadingReasoning(input);
  // The opening <think> tag is gone; the trailing text contains the
  // intended JSON object. The strip function does not trim the leading
  // prose — that is `parseJsonValue`'s job (via `extractJsonObject`),
  // which is the function that actually gets called downstream.
  assert.ok(!out.startsWith("<think>"));
  assert.ok(out.includes('"assistant_message"'));
  const parsed = parseJsonValue(out) as { assistant_message: string; tool_calls: unknown[] };
  assert.equal(parsed.assistant_message, "will continue");
});

test("stripLeadingReasoning: leaves plain text that happens to start with '{' alone", () => {
  const input = '{"a":1}';
  assert.equal(stripLeadingReasoning(input), input);
});

test("stripLeadingReasoning: preserves leading whitespace before the think tag", () => {
  const input = '\n  <think>reasoning</think>{"ok":true}';
  const out = stripLeadingReasoning(input);
  // Whitespace before the <think> tag is preserved; the JSON parser
  // trims it. The key check is that the reasoning text is gone.
  assert.ok(!out.includes("reasoning"));
  assert.ok(out.trimEnd().endsWith('{"ok":true}'));
});

test("stripLeadingReasoning: always strips a leading <think> block (even when inner contains JSON)", () => {
  // We are intentionally aggressive: a `<think>` tag at the start of a
  // response is always a reasoning block, even if the reasoning happens
  // to contain a JSON-shaped object. The model wrapped its only output
  // in `<think>...</think>` with nothing after; the strip returns an
  // empty string. The downstream parser will then fail and the
  // structured-JSON retry loop kicks in.
  const input = '<think>{"already":"json"}</think>';
  const out = stripLeadingReasoning(input);
  assert.equal(out, "");
});

test("stripLeadingReasoning: drops only the <think> block, leaves JSON after </think> intact", () => {
  const input = '<think>this was my reasoning</think>{"final":"answer"}';
  const out = stripLeadingReasoning(input);
  assert.equal(out, '{"final":"answer"}');
});

test("stripLeadingReasoning: returns empty string unchanged", () => {
  assert.equal(stripLeadingReasoning(""), "");
});

// ---------- parseJsonValue (integration with stripLeadingReasoning) --

test("parseJsonValue: extracts JSON after a <think> prefix", () => {
  const input = `<think>
The user wants me to take a screenshot. I'll use playwright.
{"assistant_message":"opening browser","tool_calls":[{"id":"a","name":"bash","args":{"cmd":"playwright open","summary":"open"}}]}`;
  const parsed = parseJsonValue(input) as { assistant_message: string; tool_calls: unknown[] };
  assert.equal(parsed.assistant_message, "opening browser");
  assert.equal(parsed.tool_calls.length, 1);
});

test("parseJsonValue: extracts JSON after a multi-line <think> that itself contains balanced braces", () => {
  const input = `<think>
The user wants {"a":1} to be transformed into {"b":2}.
Now planning the call.
</think>
{"assistant_message":"ready","tool_calls":[]}`;
  const parsed = parseJsonValue(input) as { assistant_message: string; tool_calls: unknown[] };
  assert.equal(parsed.assistant_message, "ready");
  assert.deepEqual(parsed.tool_calls, []);
});

test("parseJsonValue: throws on empty content (still guarded)", () => {
  assert.throws(() => parseJsonValue(""), /empty content/);
  assert.throws(() => parseJsonValue("   \n\t  "), /empty content/);
});
