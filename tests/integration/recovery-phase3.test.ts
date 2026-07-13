import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeEngine } from "../../src/runtime/engine.js";
import { RecoverySession } from "../../src/recovery/session.js";
import { ShadowCheckpoint } from "../../src/recovery/checkpoint.js";
import { MergeConflictError } from "../../src/recovery/wal.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("WAL-aware reads see staged writes before flush while disk stays unchanged", async () => {
  const workspaceRoot = await createTempWorkspace();
  const recovery = new RecoverySession({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
  });

  await recovery.ensureCheckpoint();
  await recovery.wal.stageReplace("src/app.ts", "41", "42");

  const staged = await recovery.wal.readText("src/app.ts");
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.match(staged, /42/);
  assert.match(disk, /41/);
});

test("rollback clears staged writes and leaves disk unchanged", async () => {
  const workspaceRoot = await createTempWorkspace();
  const recovery = new RecoverySession({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
  });

  await recovery.ensureCheckpoint();
  await recovery.wal.stageWrite("src/app.ts", "export const answer = 99;\n");
  await recovery.rollback("Manual rollback for test");

  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(disk, /41/);
  assert.equal(recovery.hasPendingWrites(), false);
});

test("abort restores pre-turn state by discarding staged writes", async () => {
  const workspaceRoot = await createTempWorkspace();
  const recovery = new RecoverySession({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
  });

  await recovery.ensureCheckpoint();
  await recovery.wal.stageReplace("src/app.ts", "41", "77");
  await recovery.abort("abort requested");

  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(disk, /41/);
});

test("final commit barrier flushes staged writes atomically to disk", async () => {
  const workspaceRoot = await createTempWorkspace();
  const recovery = new RecoverySession({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
  });

  await recovery.ensureCheckpoint();
  await recovery.wal.stageReplace("src/app.ts", "41", "42");
  await recovery.wal.stageWrite("src/extra.ts", "export const extra = true;\n");
  const result = await recovery.flushFinal();

  assert.equal(result.written, 2);
  const app = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  const extra = await readFile(path.join(workspaceRoot, "src", "extra.ts"), "utf8");
  assert.match(app, /42/);
  assert.match(extra, /extra = true/);
});

test("direct file conflicts are detected during flush and disk remains unchanged", async () => {
  const workspaceRoot = await createTempWorkspace();
  const recovery = new RecoverySession({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
  });

  await recovery.ensureCheckpoint();
  await recovery.wal.stageReplace("src/app.ts", "41", "42");
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 100;\n", "utf8");

  await assert.rejects(() => recovery.flushFinal(), (error: unknown) => {
    assert.ok(error instanceof MergeConflictError);
    assert.match(error.message, /direct file conflicts/);
    assert.match(error.conflicts[0]?.conflictText ?? "", /CURRENT_DISK/);
    return true;
  });

  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(disk, /100/);
});

test("shadow checkpoint restore returns the tracked workspace to its original git state", async () => {
  const workspaceRoot = await createTempWorkspace();
  const checkpoint = await ShadowCheckpoint.create(workspaceRoot);

  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 500;\n", "utf8");
  await checkpoint.restore();

  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(disk, /41/);
});

test("shadow checkpoint restore tolerates empty initial commits", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-empty-git-"));
  await run("git", ["init"], workspaceRoot);
  await run("git", ["commit", "--allow-empty", "-m", "Initial empty commit"], workspaceRoot);

  const checkpoint = await ShadowCheckpoint.create(workspaceRoot);
  await checkpoint.restore();
});

test("runtime engine flushes staged writes at turn completion", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Stage and flush writes",
    tool_calls: [
      { id: "1", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
    ],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");

  assert.equal(result.toolResults[0]?.ok, true);
  assert.match(disk, /42/);
});

async function run(command: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Reaper Tests",
          GIT_AUTHOR_EMAIL: "reaper-tests@example.com",
          GIT_COMMITTER_NAME: "Reaper Tests",
          GIT_COMMITTER_EMAIL: "reaper-tests@example.com",
        },
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      },
    );
  });
}

test("runtime engine preserves successful writes when a sibling write fails", async () => {
  const workspaceRoot = await createTempWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Cause write failure",
    tool_calls: [
      { id: "1", name: "replace_in_file", args: { path: "src/app.ts", oldString: "41", newString: "42" } },
      { id: "2", name: "replace_in_file", args: { path: "src/app.ts", oldString: "does-not-exist", newString: "x" } },
    ],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();
  const disk = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  const trajectory = await readFile(result.trajectoryPath, "utf8");

  assert.equal(result.toolResults[0]?.ok, true);
  assert.equal(result.toolResults[1]?.ok, false);
  assert.match(disk, /42/);
  assert.match(trajectory, /"status":"failed"/);
});
