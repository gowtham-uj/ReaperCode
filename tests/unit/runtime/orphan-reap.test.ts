/**
 * End-to-end test for the orphan-reap wire-up.
 *
 * Scenario this simulates: a previous Reaper run spawned a long-lived
 * child process (e.g. `npm run dev`), then crashed (SIGKILL of the
 * Reaper process), leaving the child behind. On the next Reaper
 * startup we should:
 *
 *   1. Find the previous run's `processes.json` via `latest-run.json`.
 *   2. SIGTERM every still-alive pid listed in the manifest.
 *   3. After a short grace, SIGKILL any holdouts.
 *
 * The test stands up:
 *   - a real `sleep 60` child (so the pid is guaranteed alive)
 *   - a synthesized `latest-run.json` pointing at a fake prior runDir
 *   - a synthesized `processes.json` listing the sleep child
 *
 * Then calls the helper and asserts the sleep child is dead.
 *
 * Opt-out: a second test confirms REAPER_DISABLE_ORPHAN_REAP=1 makes
 * the helper a no-op even when a manifest exists.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { reapOrphansFromPreviousRun } from "../../../src/runtime/orphan-reap.js";

async function spawnLongLivedChild(): Promise<{ pid: number; kill: () => void }> {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  if (!child.pid) {
    throw new Error("failed to spawn sleep child");
  }
  return {
    pid: child.pid,
    kill: () => {
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface FakeRun {
  workspaceRoot: string;
  scratchpadRoot: string;
  previousRunId: string;
  previousRunDir: string;
  cleanup: () => Promise<void>;
}

async function setupFakeRunWithManifest(manifestProcesses: { pid: number; cmd: string }[]): Promise<FakeRun> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-orphan-reap-"));
  const scratchpadRoot = path.join(workspaceRoot, ".reaper");
  const previousRunId = "run-previous-deadbeef";
  const previousRunDir = path.join(scratchpadRoot, "runs", previousRunId);
  await mkdir(previousRunDir, { recursive: true });

  // latest-run.json — what the helper will read.
  await writeFile(
    path.join(scratchpadRoot, "latest-run.json"),
    JSON.stringify(
      {
        runId: previousRunId,
        runDir: previousRunDir,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  // processes.json — the manifest the helper will reap from.
  await writeFile(
    path.join(previousRunDir, "processes.json"),
    JSON.stringify(
      {
        runId: previousRunId,
        updatedAt: new Date().toISOString(),
        processes: manifestProcesses.map((p) => ({
          pid: p.pid,
          status: "running",
          exitCode: null,
          startedAt: new Date().toISOString(),
          cmd: p.cmd,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    workspaceRoot,
    scratchpadRoot,
    previousRunId,
    previousRunDir,
    cleanup: async () => {
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

test("reapOrphansFromPreviousRun SIGTERMs a live orphan listed in the manifest", async () => {
  const child = await spawnLongLivedChild();
  assert.equal(isPidAlive(child.pid), true, "preflight: sleep child should be alive");

  const fakeRun = await setupFakeRunWithManifest([{ pid: child.pid, cmd: "sleep 60" }]);

  try {
    const outcome = await reapOrphansFromPreviousRun(
      fakeRun.workspaceRoot,
      "run-new-cafef00d",
      { env: {} },
    );

    assert.equal(outcome.status, "reaped", `expected reaped, got ${outcome.status}`);
    assert.equal(outcome.previousRunId, fakeRun.previousRunId);
    assert.equal(outcome.reaped, 1, "should have reaped exactly one orphan");

    // Give the OS a moment to actually deliver SIGTERM. We poll
    // rather than sleep a fixed window so the test is fast on
    // clean machines and tolerant on slow CI.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isPidAlive(child.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(isPidAlive(child.pid), false, "orphan should be reaped within 5s");
  } finally {
    child.kill();
    await fakeRun.cleanup();
  }
});

test("reapOrphansFromPreviousRun is a no-op when REAPER_DISABLE_ORPHAN_REAP=1", async () => {
  const child = await spawnLongLivedChild();
  const fakeRun = await setupFakeRunWithManifest([{ pid: child.pid, cmd: "sleep 60" }]);

  try {
    const outcome = await reapOrphansFromPreviousRun(
      fakeRun.workspaceRoot,
      "run-new-cafef00d",
      { env: { REAPER_DISABLE_ORPHAN_REAP: "1" } },
    );

    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.reason, "REAPER_DISABLE_ORPHAN_REAP=1");
    assert.equal(isPidAlive(child.pid), true, "child should still be alive under opt-out");
  } finally {
    child.kill();
    await fakeRun.cleanup();
  }
});

test("reapOrphansFromPreviousRun returns no-previous-run when latest-run.json is absent", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-orphan-reap-"));
  try {
    const outcome = await reapOrphansFromPreviousRun(
      workspaceRoot,
      "run-new-cafef00d",
      { env: {} },
    );
    assert.equal(outcome.status, "no-previous-run");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("reapOrphansFromPreviousRun returns no-previous-run when pointer points at the current run", async () => {
  // This covers the "Reaper resume" path: the user re-runs Reaper
  // against an existing runId, and the manifest pointer still points
  // at that same runId. There are no orphans to reap — those are
  // still our own children.
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-orphan-reap-"));
  const scratchpadRoot = path.join(workspaceRoot, ".reaper");
  const sameRunId = "run-resume-1234";
  const runDir = path.join(scratchpadRoot, "runs", sameRunId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(scratchpadRoot, "latest-run.json"),
    JSON.stringify({ runId: sameRunId, runDir, updatedAt: new Date().toISOString() }),
    "utf8",
  );

  try {
    const outcome = await reapOrphansFromPreviousRun(
      workspaceRoot,
      sameRunId,
      { env: {} },
    );
    assert.equal(outcome.status, "no-previous-run");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
