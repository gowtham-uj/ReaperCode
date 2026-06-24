import test from "node:test";
import assert from "node:assert/strict";
import { ToolExecutor } from "../../src/tools/executor.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

async function createExecutor(workspaceRoot: string) {
  return new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });
}

test("unknown tool returns error with UNKNOWN_TOOL code", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "nonexistent_tool" as any,
    args: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNKNOWN_TOOL");
  assert.match(result.error?.message ?? "", /Unknown tool 'nonexistent_tool'/);
});

test("unknown tool loop guard triggers after 3 consecutive unknown tools", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  // First two unknown tools return UNKNOWN_TOOL
  const r1 = await executor.execute({ id: "1", name: "bad_tool_1" as any, args: {} });
  assert.equal(r1.error?.code, "UNKNOWN_TOOL");

  const r2 = await executor.execute({ id: "2", name: "bad_tool_2" as any, args: {} });
  assert.equal(r2.error?.code, "UNKNOWN_TOOL");

  // Third unknown tool triggers the loop guard
  const r3 = await executor.execute({ id: "3", name: "bad_tool_3" as any, args: {} });
  assert.equal(r3.ok, false);
  assert.equal(r3.error?.code, "UNKNOWN_TOOL_LOOP");
  assert.match(r3.error?.message ?? "", /3 times in a row/);
});

test("known tool resets consecutive unknown counter", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  // Two unknown tools
  const r1 = await executor.execute({ id: "1", name: "bad_tool" as any, args: {} });
  assert.equal(r1.error?.code, "UNKNOWN_TOOL");
  const r2 = await executor.execute({ id: "2", name: "bad_tool" as any, args: {} });
  assert.equal(r2.error?.code, "UNKNOWN_TOOL");

  // Known tool resets counter
  const rKnown = await executor.execute({ id: "3", name: "read_file", args: { path: "README.md" } });
  assert.equal(rKnown.ok, true);

  // Next unknown tool should NOT trigger loop guard because counter was reset
  const r3 = await executor.execute({ id: "4", name: "bad_tool" as any, args: {} });
  assert.equal(r3.error?.code, "UNKNOWN_TOOL");
});

test("unknown tool loop guard requires 3 in a row, not cumulative", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const codes: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await executor.execute({ id: String(i), name: `bad_tool_${i}` as any, args: {} });
    codes.push(r.error?.code ?? "ok");
    if (r.error?.code === "UNKNOWN_TOOL_LOOP") break;
  }

  assert.deepEqual(codes, ["UNKNOWN_TOOL", "UNKNOWN_TOOL", "UNKNOWN_TOOL_LOOP"]);
});
