import test from "node:test";
import assert from "node:assert/strict";

import { pruneToolOutputs } from "../../src/context/tool-output-prune.js";

function bigTool(content: string, id: string): Record<string, unknown> {
  return { role: "tool", tool_call_id: id, content };
}

test("pruneToolOutputs truncates old tool results outside protect window", () => {
  const old = "x".repeat(100_000);
  const recent = "y".repeat(50_000);
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "cockpit" },
    bigTool(old, "old-1"),
    bigTool(old, "old-2"),
    bigTool(recent, "new-1"),
  ];
  const result = pruneToolOutputs(messages, {
    protectChars: 60_000,
    minSavingsChars: 50_000,
    warmPrefixCount: 1,
  });
  assert.equal(result.performed, true);
  assert.ok(result.pruned >= 1);
  assert.ok(result.savedChars >= 50_000);
  assert.match(String(messages[1]!.content), /Output truncated/);
  assert.equal(messages[3]!.content, recent);
});

test("pruneToolOutputs no-ops when savings below minimum", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "cockpit" },
    bigTool("small", "a"),
    bigTool("also-small", "b"),
  ];
  const result = pruneToolOutputs(messages, {
    protectChars: 10,
    minSavingsChars: 50_000,
  });
  assert.equal(result.performed, false);
  assert.equal(result.pruned, 0);
});
