import test from "node:test";
import assert from "node:assert/strict";

import { splitControlToolCalls } from "../../../src/runtime/runtime-state.js";
import { ToolCallSchema, type ToolCall } from "../../../src/tools/types.js";

function toolCall(name: string, args: unknown, id?: string): ToolCall {
  const parsed = ToolCallSchema.parse({ id: id ?? `${name}-1`, name, args });
  return parsed;
}

test("splitControlToolCalls: plain executable batch passes through untouched", () => {
  const calls = [
    toolCall("bash", { cmd: "npm test", timeout: 120 }),
    toolCall("file_view", { path: "README.md" }),
  ];
  const split = splitControlToolCalls(calls);
  assert.deepEqual(split.executableToolCalls, calls);
  assert.equal(split.advisoryToolCalls, undefined);
  assert.equal(split.advancementSignal, undefined);
});

test("splitControlToolCalls: advance_step becomes advancementSignal", () => {
  const calls = [
    toolCall("advance_step", { summary: "wrote the test", evidence: ["tests pass"] }, "adv-1"),
    toolCall("file_view", { path: "README.md" }),
  ];
  const split = splitControlToolCalls(calls);
  assert.equal(split.executableToolCalls.length, 1);
  assert.equal(split.executableToolCalls[0]!.name, "file_view");
  assert.equal(split.advisoryToolCalls, undefined);
  assert.ok(split.advancementSignal);
  assert.equal(split.advancementSignal.name, "advance_step");
  assert.equal(split.advancementSignal.id, "adv-1");
  assert.equal(split.advancementSignal.args.summary, "wrote the test");
  assert.deepEqual(split.advancementSignal.args.evidence, ["tests pass"]);
});

test("splitControlToolCalls: update_plan/update_todo become advisoryToolCalls", () => {
  const calls = [
    toolCall("update_plan", { markdown: "## Plan\n- inspect" }, "plan-1"),
    toolCall("update_todo", { items: [{ id: "inspect", content: "Inspect repo" }] }, "todo-1"),
    toolCall("bash", { cmd: "ls" }),
  ];
  const split = splitControlToolCalls(calls);
  assert.equal(split.executableToolCalls.length, 1);
  assert.equal(split.executableToolCalls[0]!.name, "bash");
  assert.equal(split.advancementSignal, undefined);
  assert.ok(split.advisoryToolCalls);
  assert.equal(split.advisoryToolCalls.length, 2);
  assert.deepEqual(
    split.advisoryToolCalls.map((call) => call.name),
    ["update_plan", "update_todo"],
  );
});

test("splitControlToolCalls: advance_step with missing summary falls back to stepId", () => {
  const calls = [toolCall("advance_step", { stepId: "step-3" }, "adv-2")];
  const split = splitControlToolCalls(calls);
  assert.ok(split.advancementSignal);
  assert.equal(split.advancementSignal.args.summary, "step-3");
});

test("control tool schemas parse (they must survive ToolCallSchema)", () => {
  // Regression guard: advance_step/update_plan/update_todo MUST be
  // members of ToolCallSchema or they would be dropped before ever
  // reaching splitControlToolCalls (R2 root cause).
  assert.ok(ToolCallSchema.safeParse({ id: "a", name: "advance_step", args: { summary: "x" } }).success);
  assert.ok(ToolCallSchema.safeParse({ id: "b", name: "update_plan", args: { markdown: "x" } }).success);
  assert.ok(ToolCallSchema.safeParse({ id: "c", name: "update_todo", args: { items: [{ id: "i", content: "c" }] } }).success);
});
