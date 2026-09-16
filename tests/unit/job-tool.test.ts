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

test("job: cancel actually terminates the process and reports the terminal state", async () => {
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
    /*
     * SIGKILL kills the process by signal, so `exitCode` stays null and only
     * `signalCode` is set. The old status check keyed on `exitCode` alone,
     * concluded the process was still running, and returned "signalled" — an
     * answer that says "we sent a signal", not "it is dead", for a signal that
     * cannot be caught. The caller is asking whether the job stopped.
     */
    assert.equal(
      result.status,
      "finished",
      "a SIGKILL'd process must be reported as finished, not merely signalled",
    );
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

/*
 * Background output must not have blank lines injected between real ones.
 *
 * The audit's finding: a background loop echoing tick-1/2/3/finished polled back
 * as `tick-1\n\ntick-2\n\ntick-3\n\nfinished`. Each `data` chunk ends in a
 * newline, and `split(/\r?\n/)` turns the trailing newline into an empty final
 * field that was pushed as a line, so re-joining put a blank between every pair.
 */
test("job: background output does not inject blank lines between chunks", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const child = spawn("bash", ["-c", "for i in 1 2 3; do echo tick-$i; done; echo finished"], { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] });
    manager.register({
      child, output: [], startedAt: new Date().toISOString(), startedAtMs: Date.now(), cmd: "loop", cwd: workspaceRoot, notified: false,
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((r) => setTimeout(r, 150));

    const polled = await executeJob({ action: "poll", jobId: String(child.pid) }, { workspaceRoot, runId: "t", processManager: manager });
    const out = polled.output ?? "";
    assert.doesNotMatch(out, /\n\n/, `blank lines injected: ${JSON.stringify(out)}`);
    assert.match(out, /tick-1\ntick-2\ntick-3\nfinished/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("job: cancel names the signal that stopped the job", async () => {
  const workspaceRoot = makeWorkspace();
  const manager = makeManager(workspaceRoot);
  try {
    const child = spawnEcho(manager, workspaceRoot);
    const result = await executeJob(
      { action: "cancel", jobId: String(child.pid), signal: "SIGKILL" },
      { workspaceRoot, runId: "t", processManager: manager },
    );
    assert.equal(result.status, "finished");
    assert.equal(result.cancelledBy, "SIGKILL", "the result must say the job was cancelled, and with what");
    assert.match(result.note ?? "", /no longer listed|cancelled/i);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
