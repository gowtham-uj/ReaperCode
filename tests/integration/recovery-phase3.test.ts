import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      { id: "1", name: "edit_file", args: { path: "src/app.ts", edits: [{ oldString: "41", newString: "42" }] } },
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
      { id: "1", name: "edit_file", args: { path: "src/app.ts", edits: [{ oldString: "41", newString: "42" }] } },
      { id: "2", name: "edit_file", args: { path: "src/app.ts", edits: [{ oldString: "does-not-exist", newString: "x" }] } },
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

/*
 * A file-tool edit and a bash write to the same file are merged, not fatal.
 *
 * The report: an agent editing files and running commands had its turn killed
 * mid-work with "The model call failed and the run was stopped: Unable to flush
 * WAL because of direct file conflicts". Nothing was wrong with the model. The
 * WAL stages file-tool writes in memory while bash writes straight to disk, so
 * the next flush found disk changed under the staged copy and threw a hard
 * conflict — and the rethrow was reported as a model failure.
 *
 * Two things had to be true and this asserts both:
 *
 *   1. When the two writes touch different lines, the flush three-way-merges
 *      them and writes the combined result, with no conflict at all.
 *   2. When they genuinely overlap, the flush still reports a conflict (it must
 *      never silently pick a winner and lose the other edit) — but the path is
 *      recoverable rather than a thrown error that ends the turn.
 */
test("a bash write to a file the WAL staged is merged when the edits do not overlap", async () => {
  const workspaceRoot = await createTempWorkspace();
  const target = path.join(workspaceRoot, "src", "app.ts");
  await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

  const recovery = new RecoverySession({
    workspaceRoot, runId: "run-merge", sessionId: "s", traceId: "t", logLevel: "info",
  });
  // The model edits line 1 through a file tool (staged, not on disk yet).
  await recovery.wal.stageWrite("src/app.ts", "ALPHA-edited\nbeta\ngamma\n");
  // Bash appends a line, straight to disk.
  await writeFile(target, "alpha\nbeta\ngamma\ndelta\n", "utf8");

  const outcome = await recovery.flushForBarrier();
  assert.equal(outcome.written, 1, "the merged write must land");
  const final = await readFile(target, "utf8");
  assert.match(final, /ALPHA-edited/, "the model's edit must survive the merge");
  assert.match(final, /delta/, "the bash write must survive the merge");
});

test("a genuine overlap stays a conflict and never silently drops an edit", async () => {
  const workspaceRoot = await createTempWorkspace();
  const target = path.join(workspaceRoot, "src", "app.ts");
  await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

  const recovery = new RecoverySession({
    workspaceRoot, runId: "run-conflict", sessionId: "s", traceId: "t", logLevel: "info",
  });
  await recovery.wal.stageWrite("src/app.ts", "alpha\nOURS\ngamma\n");
  await writeFile(target, "alpha\nTHEIRS\ngamma\n", "utf8");

  await assert.rejects(
    () => recovery.flushForBarrier(),
    (error: unknown) => error instanceof MergeConflictError,
    "an overlapping edit must be reported as a conflict, not resolved by guessing",
  );
  const final = await readFile(target, "utf8");
  assert.match(final, /THEIRS/, "the conflict must leave the on-disk version untouched");
  assert.doesNotMatch(final, /<<<<<<</, "conflict markers must never be written to the user's file");
});

/*
 * A write staged for a file that was then deleted on disk is not a conflict.
 *
 * This is the live shape from a real thread. Inside one eval call the agent ran
 * `fs.writeFileSync` (disk), `tools.edit_file` (staged in the WAL), then
 * `fs.unlinkSync` (disk delete) — a create/edit/cleanup in a single script. At
 * the next barrier the flush found the file gone and reported "Unable to flush
 * WAL because of direct file conflicts" against a file the same call had just
 * deleted, which rolled back the edit and (before the scheduler fix) ended the
 * turn. The delete is the later action and it wins; there is nothing to write.
 */
test("a staged write for a file deleted on disk is dropped, not a conflict", async () => {
  const workspaceRoot = await createTempWorkspace();
  const target = path.join(workspaceRoot, "audit-edit-test.txt");
  await writeFile(target, "ONE\nTWO\nTHREE\n", "utf8");

  const recovery = new RecoverySession({
    workspaceRoot, runId: "run-deleted", sessionId: "s", traceId: "t", logLevel: "info",
  });
  // `tools.edit_file` stages the change...
  await recovery.wal.stageWrite("audit-edit-test.txt", "ONE\nTWO-EDITED\nTHREE\n");
  // ...then the same script deletes the file from disk.
  await rm(target, { force: true });

  // Must not throw: the delete is the intended end state.
  const outcome = await recovery.flushForBarrier();
  assert.equal(outcome.written, 0, "nothing to write; the file was deleted");
  await assert.rejects(
    () => readFile(target, "utf8"),
    "the deleted file must not be resurrected from the staged copy",
  );
});

test("a staged delete whose file is already gone is satisfied, not a conflict", async () => {
  const workspaceRoot = await createTempWorkspace();
  const target = path.join(workspaceRoot, "audit-del-test.txt");
  await writeFile(target, "content\n", "utf8");

  const recovery = new RecoverySession({
    workspaceRoot, runId: "run-dbl-delete", sessionId: "s", traceId: "t", logLevel: "info",
  });
  await recovery.wal.stageDelete("audit-del-test.txt");
  await rm(target, { force: true });

  const outcome = await recovery.flushForBarrier();
  assert.equal(outcome.deleted, 0, "already gone; the staged delete needs no action");
});
