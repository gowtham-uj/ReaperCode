import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { batchNeedsMutationCheckpoint, createCheckpoint, getCheckpointDir, readCheckpoint, restoreCheckpoint } from "../../src/runtime/checkpoints.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("checkpoint creation captures metadata and dirty files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 42;\n", "utf8");

  const checkpoint = await createCheckpoint({
    workspaceRoot,
    reason: "unit test checkpoint",
    toolCallIds: ["tool-1", "tool-2"],
  });

  assert.match(checkpoint.id, /^cp-/);
  assert.ok(!Number.isNaN(Date.parse(checkpoint.createdAt)));
  assert.notEqual(checkpoint.baseRevision, "unavailable");
  assert.deepEqual(checkpoint.dirtyFilesBefore, ["src/app.ts"]);
  assert.equal(checkpoint.reason, "unit test checkpoint");
  assert.deepEqual(checkpoint.toolCallIds, ["tool-1", "tool-2"]);
  assert.equal(checkpoint.restoreAvailable, true);

  const persisted = await readCheckpoint(workspaceRoot, checkpoint.id);
  assert.deepEqual(persisted, checkpoint);

  const patch = await readFile(path.join(getCheckpointDir(workspaceRoot, checkpoint.id), "worktree.patch"), "utf8");
  assert.match(patch, /answer = 42/);
});

test("mutation checkpoint classifier skips read-only and checkpoint-only batches", () => {
  assert.equal(batchNeedsMutationCheckpoint([{ name: "read_file" }, { name: "git_status" }]), false);
  assert.equal(batchNeedsMutationCheckpoint([{ name: "create_checkpoint" }]), false);
  assert.equal(batchNeedsMutationCheckpoint([{ name: "write_file" }]), true);
  assert.equal(batchNeedsMutationCheckpoint([{ name: "bash" }]), true);
});

test("restore rejects path-like checkpoint ids", async () => {
  const workspaceRoot = await createTempWorkspace();
  await assert.rejects(
    () => restoreCheckpoint(workspaceRoot, "../outside"),
    /Invalid checkpoint id/,
  );
});
