import test from "node:test";
import assert from "node:assert/strict";

import { ToolCallSchema } from "../../../src/tools/types.js";
import { normalizeToolCall } from "../../../src/tools/normalize.js";

test("normalizeToolCall preserves scratchpad action/note/label from streamed function.arguments", () => {
  const args = {
    action: "append",
    note: "Diagnosis: clamp ignores max",
    label: "clamp bug diagnosis",
  };
  const normalized = normalizeToolCall({
    id: "call_scratch_1",
    name: "scratchpad",
    function: {
      name: "scratchpad",
      arguments: JSON.stringify(args),
    },
  });
  const parsed = ToolCallSchema.safeParse(normalized);
  assert.equal(parsed.success, true, JSON.stringify((parsed as any).error?.issues ?? normalized));
  if (parsed.success) {
    assert.equal(parsed.data.name, "scratchpad");
    assert.equal(parsed.data.args.action, "append");
    assert.equal(parsed.data.args.note, args.note);
    assert.equal(parsed.data.args.label, args.label);
  }
});

test("normalizeToolCall preserves search_memory and call_subagent args", () => {
  const memory = normalizeToolCall({
    id: "call_mem_1",
    name: "search_memory",
    function: {
      name: "search_memory",
      arguments: JSON.stringify({ query: "AMBER-FOX", max_hits: 5 }),
    },
  });
  const memParsed = ToolCallSchema.safeParse(memory);
  assert.equal(memParsed.success, true, JSON.stringify((memParsed as any).error?.issues));

  const sub = normalizeToolCall({
    id: "call_sub_1",
    name: "call_subagent",
    function: {
      name: "call_subagent",
      arguments: JSON.stringify({ type: "reviewer", task: "review the diff" }),
    },
  });
  const subParsed = ToolCallSchema.safeParse(sub);
  assert.equal(subParsed.success, true, JSON.stringify((subParsed as any).error?.issues));
});

test("normalizeToolCall default branch preserves unknown tool payload fields", () => {
  const normalized = normalizeToolCall({
    id: "call_skill_1",
    name: "create_skill",
    function: {
      name: "create_skill",
      arguments: JSON.stringify({
        name: "demo-skill",
        description: "A demo skill for tests",
      }),
    },
  }) as { name?: string; args?: Record<string, unknown> };
  assert.equal(normalized.name, "create_skill");
  assert.equal(normalized.args?.name, "demo-skill");
  assert.equal(normalized.args?.description, "A demo skill for tests");
});
