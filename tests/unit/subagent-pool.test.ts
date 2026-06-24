import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

import { SubagentPool } from "../../src/runtime/subagent-pool.js";
import {
  createSubagentJob,
  getSubagentJob,
  subagentJobs,
} from "../../src/runtime/subagent-state.js";
import type {SubagentJob, SubagentStatus} from "../../src/runtime/subagent-state.js";

test("SubagentPool starts a background job and reports it via running status", async () => {
  subagentJobs.clear();
  const runDir = await mkdtemp(path.join(os.tmpdir(), "reaper-subagent-"));
  try {
    const pool = await SubagentPool.create({
      config: {},
      workspaceRoot: runDir,
      runDir,
      workerPath: fakeWorkerPath("complete"),
      workerExecArgv: [],
    });

    const job = createSubagentJob({
      type: "researcher",
      task: "Explore patterns",
      mode: "background",
      observedFiles: [path.join(runDir, "data.txt")],
    });

    await pool.run(job);
    const current = getSubagentJob(job.id);
    assert.equal(current?.status, "running");

    await waitFor(() => getSubagentJob(job.id)?.status === "completed", 2000);
    assert.deepEqual(getSubagentJob(job.id)?.result, { ok: true });

    await pool.close();
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    subagentJobs.clear();
  }
});

test("SubagentPool captures job failure from worker", async () => {
  subagentJobs.clear();
  const runDir = await mkdtemp(path.join(os.tmpdir(), "reaper-subagent-"));
  try {
    const pool = await SubagentPool.create({
      config: {},
      workspaceRoot: runDir,
      runDir,
      workerPath: fakeWorkerPath("error"),
      workerExecArgv: [],
    });

    const job = createSubagentJob({ type: "planner", task: "Plan", mode: "background" });
    await pool.run(job);
    await waitFor(() => getSubagentJob(job.id)?.status === "failed", 2000);
    assert.ok(getSubagentJob(job.id)?.error);

    await pool.close();
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    subagentJobs.clear();
  }
});

test("SubagentPool records base file snapshot for observed files", async () => {
  subagentJobs.clear();
  const runDir = await mkdtemp(path.join(os.tmpdir(), "reaper-subagent-"));
  try {
    const file = path.join(runDir, "tracked.txt");
    await writeFile(file, "initial content", "utf8");

    const pool = await SubagentPool.create({
      config: {},
      workspaceRoot: runDir,
      runDir,
      workerPath: fakeWorkerPath("complete"),
      workerExecArgv: [],
    });

    const job = createSubagentJob({
      type: "reviewer",
      task: "Review",
      mode: "background",
      observedFiles: [file],
    });
    await pool.run(job);
    await waitFor(() => getSubagentJob(job.id)?.status === "completed", 2000);

    const current = getSubagentJob(job.id)!;
    assert.ok(current.baseFilesSnapshot);
    assert.ok(current.baseFilesSnapshot.length > 0);
    assert.equal(current.observedFiles![0], file);

    await pool.close();
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    subagentJobs.clear();
  }
});

test("SubagentPool flushCompleted returns only completed/failed/cancelled jobs", async () => {
  subagentJobs.clear();
  const runDir = await mkdtemp(path.join(os.tmpdir(), "reaper-subagent-"));
  try {
    const pool = await SubagentPool.create({
      config: {},
      workspaceRoot: runDir,
      runDir,
      workerPath: fakeWorkerPath("complete"),
      workerExecArgv: [],
    });
    const completed = createSubagentJob({ type: "tester", task: "Test", mode: "background" });
    const pending = createSubagentJob({ type: "researcher", task: "Research", mode: "background" });
    await pool.run(completed);
    (pending as SubagentJob).status = "pending" as SubagentStatus;
    await waitFor(() => getSubagentJob(completed.id)?.status === "completed", 2000);
    const flushed = pool.flushCompleted();
    assert.ok(flushed.some((j) => j.id === completed.id));
    assert.ok(!flushed.some((j) => j.id === pending.id));

    await pool.close();
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    subagentJobs.clear();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fakeWorkerPath(outcome: "complete" | "error"): string {
  return path.resolve(import.meta.dirname, "fixtures", `fake-subagent-worker-${outcome}.mjs`);
}
