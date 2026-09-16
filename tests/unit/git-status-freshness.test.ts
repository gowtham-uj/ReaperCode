import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { RecoverySession } from "../../src/recovery/session.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import { outputOf } from "../helpers/tool-output.js";

interface GitStatusOutput {
  statusShort: string;
  entries: Array<{ code: string; path: string }>;
}

async function createExecutorWithRecovery(workspaceRoot: string) {
  const recoverySession = new RecoverySession({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
  });
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    recoverySession,
  });
  return { executor, recoverySession };
}

test("git_status reflects a write_file from earlier in the same turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  const { executor } = await createExecutorWithRecovery(workspaceRoot);

  // Under a recovery session, write_file stages its content in the WAL
  // instead of touching disk immediately (so hasPendingWrites()/rollback
  // stay accurate). git_status shells out to a real `git status` against the
  // files on disk, so without a flush it reads the pre-write tree and misses
  // the file for the rest of the turn, only picking it up once some later
  // barrier flushes the WAL. This reproduces that "write then immediately
  // read status" sequence within a single turn.
  const writeResult = await executor.execute({
    id: "write-1",
    name: "write_file",
    args: { path: "fixtures/brand_new.txt", content: "hello\n" },
  });
  assert.equal(writeResult.ok, true);

  const statusResult = await executor.execute({
    id: "status-1",
    name: "git_status",
    args: {},
  });
  assert.equal(statusResult.ok, true);
  const status = outputOf<GitStatusOutput>(statusResult);

  assert.ok(
    status.entries.some((entry) => entry.path === "fixtures/brand_new.txt" && entry.code === "??"),
    `expected fixtures/brand_new.txt to appear as untracked, got: ${JSON.stringify(status.entries)}`,
  );
});

test("create_checkpoint captures a write_file from earlier in the same turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  const { executor } = await createExecutorWithRecovery(workspaceRoot);

  const writeResult = await executor.execute({
    id: "write-1",
    name: "write_file",
    args: { path: "src/app.ts", content: "export const answer = 999;\n" },
  });
  assert.equal(writeResult.ok, true);

  const checkpointResult = await executor.execute({
    id: "checkpoint-1",
    name: "create_checkpoint",
    args: { reason: "checkpoint right after a staged write" },
  });
  assert.equal(checkpointResult.ok, true);
  const checkpoint = outputOf<{ id: string; dirtyFilesBefore: string[] }>(checkpointResult);

  assert.ok(
    checkpoint.dirtyFilesBefore.includes("src/app.ts"),
    `expected src/app.ts in dirtyFilesBefore, got: ${JSON.stringify(checkpoint.dirtyFilesBefore)}`,
  );

  const patchPath = path.join(workspaceRoot, ".reaper", "checkpoints", checkpoint.id, "worktree.patch");
  const { readFile } = await import("node:fs/promises");
  const patch = await readFile(patchPath, "utf8");
  assert.match(patch, /answer = 999/);
});
