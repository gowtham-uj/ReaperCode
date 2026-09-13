import test from "node:test";
import assert from "node:assert/strict";

import { partitionsForParallelExecution } from "../../../src/execution/optimizer.js";
import { executeToolCalls } from "../../../src/execution/scheduler.js";
import { classifyToolCall } from "../../../src/execution/planner.js";
import { declaredResourcesForToolCall } from "../../../src/tools/resource-keys.js";
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

test("eval is a barrier, so a script never observes an unflushed write", () => {
  /*
   * The reason this matters is not ordering for its own sake. File writes are
   * staged in a write-ahead log and only reach disk when the scheduler flushes
   * at a barrier — so a script sharing a turn with a `write_file` would run
   * against a workspace where that file does not exist yet. For a script
   * reading through `tools.*` that is mostly invisible, because those calls go
   * through the same staging. For a script reading with `fs`, which is the
   * entire point of Code Mode, it silently returns the stale version.
   *
   * The default branch of `classifyToolCall` is `"read"`, so before this was
   * explicit, `eval` was a read: it shared a parallel island with the writes
   * around it and nothing was ever flushed before it started.
   */
  const evalCall = call("e", "eval", { code: "1" });
  assert.equal(classifyToolCall(evalCall), "shell_barrier");

  // And the two halves that make the barrier real to the scheduler.
  assert.equal(declaredResourcesForToolCall(evalCall).declared, false);
  assert.deepEqual(declaredResourcesForToolCall(evalCall).keys, ["shell:barrier"]);

  const partition = partitionsForParallelExecution([
    call("w", "write_file", { path: "src/a.ts", content: "a" }),
    evalCall,
    call("r", "file_view", { path: "src/a.ts" }),
  ]);
  assert.equal(partition.islands.length, 3, "a barrier splits the batch in two");
  assert.equal(partition.islands[1]!.startsWithShellBarrier, true);
  assert.deepEqual(partition.islands.map((island) => island.calls.length), [1, 1, 1]);
});

test("two evals in one turn are serialized against each other, not run side by side", () => {
  // Both report the same barrier key, and the optimizer refuses to put two
  // calls that share a key into one island when either is not a read. Two
  // scripts writing to the same workspace at once is exactly the collision
  // this avoids.
  const partition = partitionsForParallelExecution([
    call("e1", "eval", { code: "1" }),
    call("e2", "eval", { code: "2" }),
  ]);
  assert.equal(partition.islands.length, 2);
  assert.deepEqual(partition.islands.map((island) => island.calls.length), [1, 1]);
  // `canParallelize` is false because `declared` is false, which is the same
  // reason `bash` gets it: the call has not said which resources it touches, so
  // the scheduler assumes all of them.
  assert.deepEqual(partition.islands.map((island) => island.canParallelize), [false, false]);
});

test("the scheduler flushes staged writes before it runs a script", async () => {
  /*
   * The other half of the barrier test above, and the half that touches disk.
   * Classification makes the evaluator *want* to flush; this is the scheduler
   * actually doing it, in the right order.
   *
   * Recording both sides into one array is the point. Asserting "flush was
   * called" would pass for a flush that happens after the script ran — which is
   * exactly the bug, since the script is what needed to see the file.
   */
  const order: string[] = [];
  const recovery = {
    hasPendingWrites: () => true,
    flushForBarrier: async () => { order.push("flush"); },
    flushFinal: async () => undefined,
    rollback: async () => undefined,
    abort: async () => undefined,
  } as any;
  const executor = {
    execute: async (toolCall: ToolCall): Promise<ToolResult> => {
      order.push(toolCall.name);
      return { name: toolCall.name, toolCallId: toolCall.id, ok: true, output: null, durationMs: 0 } as ToolResult;
    },
  } as any;

  await executeToolCalls(
    [
      call("w", "write_file", { path: "src/a.ts", content: "a" }),
      call("e", "eval", { code: "readFileSync('src/a.ts', 'utf8')" }),
    ],
    executor,
    recovery,
  );

  assert.deepEqual(order, ["write_file", "flush", "eval"], "the write must be on disk before the script runs");
});

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

