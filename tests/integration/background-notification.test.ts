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

test("background process can be started and read", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  // Start a background command that produces output
  const startResult = await executor.execute({
    id: "1",
    name: "bash",
    args: { cmd: "sleep 2 && echo hello", isBackground: true, timeout: 60},
  });

  assert.equal(startResult.ok, true);
  const pid = (startResult.output as { pid: number }).pid;
  assert.ok(typeof pid === "number");

  // Verify it's running
  let processes = executor.getBackgroundProcesses();
  assert.ok(processes.some((p) => p.pid === pid && p.status === "running"));

  // Read output (may be empty while running)
  const readResult = await executor.execute({
    id: "2",
    name: "read_background_output",
    args: { pid, lines: 10 },
  });
  assert.equal(readResult.ok, true);
  assert.equal((readResult.output as { status: string }).status, "running");
});

test("background process cleanup uses tree-kill reliably", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const startResult = await executor.execute({
    id: "1",
    name: "bash",
    args: { cmd: "sleep 60", isBackground: true, timeout: 60},
  });

  assert.equal(startResult.ok, true);
  const pid = (startResult.output as { pid: number }).pid;
  assert.ok(typeof pid === "number");

  // Cleanup should terminate the process without errors
  await assert.doesNotReject(() => executor.cleanupBackgroundProcesses("test"));

  // Verify process is gone
  const processes = executor.getBackgroundProcesses();
  assert.equal(processes.find((p) => p.pid === pid), undefined);
});
