import test from "node:test";
import assert from "node:assert/strict";

import { partitionsForParallelExecution } from "../../../src/execution/optimizer.js";
import { executeToolCalls } from "../../../src/execution/scheduler.js";
import type { ToolCall, ToolResult } from "../../../src/tools/types.js";

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, args } as ToolCall;
}

function recoveryStub() {
  return {
    hasPendingWrites: () => false,
    flushForBarrier: async () => undefined,
    flushFinal: async () => undefined,
    rollback: async () => undefined,
    abort: async () => undefined,
  } as any;
}

test("partitionsForParallelExecution groups disjoint file_edit calls into one parallel island", () => {
  const partition = partitionsForParallelExecution([
    call("a", "file_edit", { path: "src/a.ts", start_line: 1, end_line: 1, new_content: "a" }),
    call("b", "file_edit", { path: "src/b.ts", start_line: 1, end_line: 1, new_content: "b" }),
    call("c", "file_edit", { path: "src/c.ts", start_line: 1, end_line: 1, new_content: "c" }),
  ]);

  assert.equal(partition.islands.length, 1);
  assert.equal(partition.islands[0]!.canParallelize, true);
  assert.equal(partition.islands[0]!.containsWrite, true);
  assert.equal(partition.islands[0]!.concurrency, 3);
});

test("partitionsForParallelExecution serializes same-path file_edit calls", () => {
  const partition = partitionsForParallelExecution([
    call("a", "file_edit", { path: "src/a.ts", start_line: 1, end_line: 1, new_content: "a" }),
    call("b", "file_edit", { path: "src/a.ts", start_line: 2, end_line: 2, new_content: "b" }),
  ]);

  assert.equal(partition.islands.length, 2);
  assert.deepEqual(partition.islands.map((island) => island.calls.length), [1, 1]);
});

test("executeToolCalls preserves original result order even when parallel calls finish out of order", async () => {
  const calls = [
    call("slow", "file_view", { path: "src/slow.ts", start_line: 1, end_line: 1 }),
    call("fast", "file_view", { path: "src/fast.ts", start_line: 1, end_line: 1 }),
  ];
  const executor = {
    execute: async (toolCall: ToolCall): Promise<ToolResult> => {
      if (toolCall.id === "slow") await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        name: toolCall.name,
        toolCallId: toolCall.id,
        ok: true,
        output: toolCall.id,
        durationMs: toolCall.id === "slow" ? 30 : 0,
      } as ToolResult;
    },
  } as any;

  const result = await executeToolCalls(calls, executor, recoveryStub());
  assert.equal(result.aborted, false);
  assert.deepEqual(result.results.map((r) => r.toolCallId), ["slow", "fast"]);
  assert.deepEqual(result.results.map((r) => r.output), ["slow", "fast"]);
});

