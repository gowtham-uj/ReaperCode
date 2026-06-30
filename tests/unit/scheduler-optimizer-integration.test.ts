import test from "node:test";
import assert from "node:assert/strict";

import { executeToolCalls } from "../../src/execution/scheduler.js";
import { ToolExecutor } from "../../src/tools/executor.js";

function call(name: string, args: Record<string, unknown> = {}, id = ""): any {
  return { id, name, args };
}

test("integration: scheduler deduplicates identical reads in the pool", async () => {
  let readCount = 0;
  const executor = new ToolExecutor({
    workspaceRoot: process.cwd(),
    runId: "test-dedup",
    sessionId: "s",
    traceId: "t",
    logLevel: "info",
    safetyProfile: { id: "default" } as any,
    permissionMode: "yolo" as any,
    config: {} as any,
  });
  // Patch the executor's run path by counting via a side effect: read
  // the same file twice; we only want one underlying read.
  // Use a manual test by mocking execute.
  (executor as any).execute = async (c: any) => {
    if (c.name === "read_file") {
      readCount += 1;
      return {
        toolCallId: c.id,
        name: c.name,
        args: c.args,
        ok: true,
        durationMs: 1,
        output: { content: "hello" },
      };
    }
    return { toolCallId: c.id, name: c.name, args: c.args, ok: true, durationMs: 1, output: {} };
  };
  const recovery = {
    abort: async () => undefined,
    rollback: async () => undefined,
    hasPendingWrites: () => false,
    flushForBarrier: async () => undefined,
    flushFinal: async () => undefined,
  } as any;
  const calls = [
    call("read_file", { path: "a.ts" }, "1"),
    call("read_file", { path: "a.ts" }, "2"),
    call("read_file", { path: "b.ts" }, "3"),
  ];
  const result = await executeToolCalls(calls, executor, recovery);
  assert.equal(result.results.length, 3);
  assert.equal(readCount, 2, "duplicate reads should collapse to one underlying call");
  for (const r of result.results) assert.ok(r.ok, "all reads should succeed");
});
