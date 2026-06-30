import test from "node:test";
import assert from "node:assert/strict";

import { validateToolCallBatch } from "../../src/runtime/tool-validation.js";

function blockerCodes(result: ReturnType<typeof validateToolCallBatch>): string[] {
  return result.blockers.map((blocker) => blocker.code);
}

test("accepts a valid main-agent tool call batch", () => {
  const result = validateToolCallBatch([
    { name: "read_file", arguments: { path: "README.md" } },
    { name: "grep_search", arguments: { pattern: "Reaper" } },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("complete_task can be batched with mutating tools", () => {
  const result = validateToolCallBatch([
    { name: "write_file", arguments: { path: "out.txt", content: "done" } },
    { name: "complete_task", arguments: { summary: "finished" } },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("complete_task can be batched with non-mutating inspection tools", () => {
  const result = validateToolCallBatch([
    { name: "read_file", arguments: { path: "README.md" } },
    { name: "complete_task", arguments: { summary: "finished" } },
  ]);

  assert.equal(result.ok, true);
});

test("complete_task can be batched with advisory memory tools", () => {
  const result = validateToolCallBatch([
    { name: "update_plan", arguments: { markdown: "## Plan\n- done" } },
    { name: "update_todo", arguments: { items: [{ id: "done", content: "Finish task", done: true }] } },
    { name: "complete_task", arguments: { summary: "finished" } },
  ]);

  assert.equal(result.ok, true);
});

test("planning-only advisory batches are allowed", () => {
  const result = validateToolCallBatch([
    { name: "update_plan", arguments: { markdown: "## Plan\n- inspect" } },
    { name: "update_todo", arguments: { items: [{ id: "inspect", content: "Inspect repo", status: "pending" }] } },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("main-agent execute_tools rejects an empty tool call list", () => {
  const result = validateToolCallBatch([], { agentRole: "main" });

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["empty_tool_call_batch"]);
});

test("subagent validation can allow empty explicit batches", () => {
  const result = validateToolCallBatch([], { agentRole: "subagent" });

  assert.equal(result.ok, true);
});

test("unknown tools are blockers unless explicitly allowed", () => {
  const blocked = validateToolCallBatch([{ name: "not_a_real_tool", arguments: {} }]);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blockerCodes(blocked), ["unknown_tool"]);

  const allowed = validateToolCallBatch([{ name: "not_a_real_tool", arguments: {} }], {
    allowUnknownTools: true,
  });
  assert.equal(allowed.ok, true);
});

test("subagent result payloads are not parsed as tool call batches", () => {
  const result = validateToolCallBatch(
    {
      taskId: "subagent-1",
      summary: "contains a JSON-looking result",
      tool_calls: [{ name: "write_file", arguments: { path: "x", content: "y" } }],
    },
    { source: "subagent_result" },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["subagent_result_payload_not_tool_calls"]);
});

test("invalid tool call shapes produce structured blockers", () => {
  const result = validateToolCallBatch([null, { name: "" }]);

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["invalid_tool_call_shape", "invalid_tool_call_shape"]);
  assert.equal(result.blockers[0]?.index, 0);
  assert.equal(result.blockers[1]?.index, 1);
});

test("tool schema errors produce structured blockers", () => {
  const result = validateToolCallBatch([{ name: "read_file", arguments: {} }], {
    validateSchema: () => ({ ok: false, details: ["arguments.path: Required"] }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["tool_schema_error"]);
  assert.deepEqual(result.blockers[0]?.details, ["arguments.path: Required"]);
});

test("non-array tool call input is rejected without throwing", () => {
  const result = validateToolCallBatch({ name: "read_file", arguments: { path: "README.md" } });

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["tool_calls_not_array"]);
});
