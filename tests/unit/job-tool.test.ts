/**
 * Tests for the `job` tool.
 *
 * The tool previously called six methods that did not exist on
 * BackgroundProcessManager. Every call was optional-chained, so each action
 * silently no-opped and reported success — `job{action:"write"}` returned
 * `{status:"written"}` having written nothing. These tests register a real
 * child process and assert each action actually observes or affects it, which
 * is the coverage that was missing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeJob } from "../../src/tools/job.js";
import { BackgroundProcessManager } from "../../src/tools/background-process-manager.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-job-tool-"));
}

function makeManager(workspaceRoot: string): BackgroundProcessManager {
  return new BackgroundProcessManager({ runId: "test-run", workspaceRoot });
}

/** Spawn a `cat` so stdin stays open and stdout echoes whatever we write. */
function spawnEcho(manager: BackgroundProcessManager, cwd: string): ChildProcess {
  const child = spawn("cat", [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  manager.register({
    child,
    output: [],
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    cmd: "cat",
    cwd,
    notified: false,
  });
  return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

test("job: list reports registered processes with their real pid", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const child = spawnEcho(manager, workspaceRoot);

    const result = await executeJob(
      { action: "list" },
      { workspaceRoot, runId: "test-run", processManager: manager },
    );

    assert.equal(result.action, "list");
    assert.equal(result.jobs?.length, 1);
    assert.equal(result.jobs?.[0]?.pid, child.pid);
    assert.equal(result.jobs?.[0]?.jobId, String(child.pid));
    assert.equal(result.jobs?.[0]?.command, "cat");
    assert.equal(result.jobs?.[0]?.status, "running");

    await manager.terminateAll("test cleanup");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: write actually reaches the child's stdin and poll observes the echo", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const child = spawnEcho(manager, workspaceRoot);
    const jobId = String(child.pid);

    const written = await executeJob(
      { action: "write", jobId, input: "hello-from-test\n" },
      { workspaceRoot, runId: "test-run", processManager: manager },
    );
    assert.equal(written.status, "written");
    assert.equal(written.error, undefined);

    // `cat` echoes stdin back to stdout; if the write were a no-op this never
    // arrives. This is the exact regression the old implementation had.
    await waitFor(() => manager.recentOutput(child.pid!, 100).includes("hello-from-test"));

    const polled = await executeJob(
      { action: "poll", jobId },
      { workspaceRoot, runId: "test-run", processManager: manager },
    );
    assert.equal(polled.status, "running");
    assert.ok(polled.output?.includes("hello-from-test"), "poll should return the echoed output");

    await manager.terminateAll("test cleanup");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: cancel actually terminates the process", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const child = spawnEcho(manager, workspaceRoot);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const result = await executeJob(
      { action: "cancel", jobId: String(child.pid), signal: "SIGKILL" },
      { workspaceRoot, runId: "test-run", processManager: manager },
    );

    assert.equal(result.action, "cancel");
    assert.equal(result.error, undefined);
    await exited;
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: unknown pid is a real error, not a silent success", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    for (const action of ["poll", "cancel", "write"] as const) {
      const result = await executeJob(
        { action, jobId: "999999999", input: "x" },
        { workspaceRoot, runId: "test-run", processManager: manager },
      );
      assert.match(result.error ?? "", /No background process found/, `${action} should report a missing pid`);
      assert.equal(result.status, undefined, `${action} must not report a status for a missing pid`);
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: non-numeric jobId is rejected rather than coerced to NaN", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const result = await executeJob(
      { action: "poll", jobId: "not-a-pid" },
      { workspaceRoot, runId: "test-run", processManager: manager },
    );
    assert.match(result.error ?? "", /Invalid jobId/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: start reports that it cannot spawn and points at bash", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const result = await executeJob(
      { action: "start", command: "sleep 10" },
      { workspaceRoot, runId: "test-run", processManager: manager },
    );
    assert.equal(result.jobId, undefined, "start must not invent a job id");
    assert.match(result.error ?? "", /bash/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: missing process manager is reported for every action", async () => {
  const workspaceRoot = makeWorkspace();
  try {
    const result = await executeJob({ action: "list" }, { workspaceRoot, runId: "test-run" });
    assert.match(result.error ?? "", /No process manager/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
