import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.equal(batchNeedsMutationCheckpoint([{ name: "file_view" }, { name: "git_status" }]), false);
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

test("worktree.patch always ends with a newline so git apply can reapply it", async () => {
  const workspaceRoot = await createTempWorkspace();
  // No trailing newline on the edit itself: this is what produced a patch
  // whose last hunk line was unterminated, which `git apply` rejects with
  // "corrupt patch at line N".
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 41;\nexport const noEol = 1;", "utf8");

  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "newline check" });
  const patch = await readFile(path.join(getCheckpointDir(workspaceRoot, checkpoint.id), "worktree.patch"), "utf8");

  assert.ok(patch.length > 0);
  assert.ok(patch.endsWith("\n"), `expected patch to end with a newline, got: ${JSON.stringify(patch.slice(-20))}`);
});

test("restore reapplies a checkpoint taken mid-edit without losing the later edit's data", async () => {
  const workspaceRoot = await createTempWorkspace();
  const appPath = path.join(workspaceRoot, "src", "app.ts");

  await writeFile(appPath, "export const answer = 41;\nexport const line2 = 1;\n", "utf8");
  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "mid-edit checkpoint" });

  await writeFile(appPath, "export const answer = 41;\nexport const line2 = 2;\n", "utf8");
  const result = await restoreCheckpoint(workspaceRoot, checkpoint.id);

  assert.equal(result.restored, true);
  const restored = await readFile(appPath, "utf8");
  assert.match(restored, /line2 = 1/);
});

/**
 * A successful restore must not delete untracked files that existed when the
 * checkpoint was taken.
 *
 * `stashWorkingTree` used `git stash push --include-untracked`, which moves
 * untracked files out of the working tree into the stash, and success drops the
 * stash — so every untracked file present at checkpoint time was destroyed by a
 * restore, exactly the files the checkpoint recorded in `dirtyFilesBefore` and
 * that a restore is supposed to leave in place. The removal walk skipped them by
 * name, which could not help: they were already gone. This asserts they survive,
 * including one inside a directory, while a file created after the checkpoint is
 * still removed.
 */
test("a restore keeps untracked files that existed at checkpoint time", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 41;\n", "utf8");
  const keptFile = path.join(workspaceRoot, "notes", "keep.md");
  const keptNested = path.join(workspaceRoot, "scratch", "deep", "inner.txt");
  await mkdir(path.dirname(keptFile), { recursive: true });
  await mkdir(path.dirname(keptNested), { recursive: true });
  await writeFile(keptFile, "pre-existing untracked\n", "utf8");
  await writeFile(keptNested, "pre-existing nested untracked\n", "utf8");

  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "untracked preservation" });
  assert.ok(checkpoint.dirtyFilesBefore.includes("notes/keep.md"), "the checkpoint should record the untracked file");

  // A file created after the checkpoint is new state and should be removed.
  await writeFile(path.join(workspaceRoot, "later.txt"), "created after checkpoint\n", "utf8");

  const result = await restoreCheckpoint(workspaceRoot, checkpoint.id);
  assert.equal(result.restored, true);

  assert.equal(await readFile(keptFile, "utf8"), "pre-existing untracked\n", "pre-existing untracked file was destroyed");
  assert.equal(await readFile(keptNested, "utf8"), "pre-existing nested untracked\n", "nested pre-existing untracked file was destroyed");
  await assert.rejects(
    () => readFile(path.join(workspaceRoot, "later.txt"), "utf8"),
    "a file created after the checkpoint must be removed by restore",
  );
});

test("a restore that fails to reapply its patch leaves the working tree exactly as it was", async () => {
  const workspaceRoot = await createTempWorkspace();
  const appPath = path.join(workspaceRoot, "src", "app.ts");

  await writeFile(appPath, "export const answer = 41;\nexport const line2 = 1;\n", "utf8");
  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "corrupt patch checkpoint" });

  // Simulate the corrupt-patch failure mode directly rather than depending on
  // a specific git version producing it, so the test still exercises the
  // real reapply path (`git apply`) via a genuinely invalid patch.
  const patchPath = path.join(getCheckpointDir(workspaceRoot, checkpoint.id), "worktree.patch");
  await writeFile(patchPath, "this is not a valid patch\n", "utf8");

  const edited = "export const answer = 41;\nexport const line2 = 2;\n";
  await writeFile(appPath, edited, "utf8");
  const newFilePath = path.join(workspaceRoot, "src", "generated-during-edit.ts");
  await writeFile(newFilePath, "export const generated = true;\n", "utf8");

  await assert.rejects(() => restoreCheckpoint(workspaceRoot, checkpoint.id));

  const afterFailure = await readFile(appPath, "utf8");
  assert.equal(afterFailure, edited, "tracked edit must survive a failed restore");
  const untrackedAfterFailure = await readFile(newFilePath, "utf8");
  assert.equal(untrackedAfterFailure, "export const generated = true;\n", "untracked file created after the checkpoint must survive a failed restore");
});

/*
 * A checkpoint taken while files were staged must restore.
 *
 * This is the audit's finding, reproduced exactly: `create_checkpoint` reported
 * `restoreAvailable: true`, and `restore_checkpoint` then failed with
 * `git apply … error: edit_probe.txt: No such file or directory`, leaving the
 * tree untouched. The cause was the apply mode — `--cached` writes the staged
 * patch to the *index* only, so the worktree stayed empty and the follow-up
 * worktree patch (a diff against the files the staged patch creates) had
 * nothing to modify. `--index` applies to both trees, which is what the two
 * patches' ordering assumes.
 */
test("a checkpoint taken with staged files restores them and re-applies the worktree", async () => {
  const workspaceRoot = await createTempWorkspace();
  // Stage a file (index only; not committed).
  await writeFile(path.join(workspaceRoot, "staged.txt"), "line-one\nline-two\n", "utf8");
  execFileSync("git", ["add", "staged.txt"], { cwd: workspaceRoot });
  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "staged-state checkpoint" });
  assert.equal(checkpoint.restoreAvailable, true);

  // A further worktree edit after the checkpoint, then restore.
  await writeFile(path.join(workspaceRoot, "staged.txt"), "line-one\nline-two-edited\n", "utf8");
  const result = await restoreCheckpoint(workspaceRoot, checkpoint.id);
  assert.equal(result.restored, true);
  // The file must exist again (the old bug left it missing) with the checkpoint's content.
  assert.equal(await readFile(path.join(workspaceRoot, "staged.txt"), "utf8"), "line-one\nline-two\n");
});

/**
 * A restore reverts an untracked file that was edited after the checkpoint.
 *
 * This is the case the earlier fix did not cover, and the reason is worth
 * stating because the two look alike. `dirtyFilesBefore` lists untracked files
 * that were present when the checkpoint was taken, and the quarantine step
 * *skips* them — deliberately, since quarantine exists to remove files created
 * *after* the checkpoint, and this file predates it. The result was a file that
 * nothing in the restore touched: it came back with the post-checkpoint edit
 * still in it, so the "recoverable checkpoint" was only recoverable for files
 * git already tracked.
 *
 * Observed directly in the audit: checkpoint, append `range()` to an untracked
 * `showcase/stats.js`, restore, `grep -c range` still returns 2.
 *
 * The file's bytes cannot be recovered from a patch — `git diff` has no side to
 * compare an untracked file against, so it produces no hunk. The checkpoint
 * copies them instead, and this asserts the edit is actually gone.
 */
test("a restore reverts an edit to a file that was untracked at checkpoint time", async () => {
  const workspaceRoot = await createTempWorkspace();
  const probe = path.join(workspaceRoot, "showcase", "stats.js");
  await mkdir(path.dirname(probe), { recursive: true });
  await writeFile(probe, "function alpha() {}\n", "utf8");

  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "untracked edit" });
  assert.ok(
    checkpoint.dirtyFilesBefore.includes("showcase/stats.js"),
    "the checkpoint should record the file as dirty before the edit",
  );

  // The edit the restore has to undo, plus a brand-new file it has to remove.
  await writeFile(probe, "function alpha() {}\nfunction beta() {}\nfunction gamma() {}\n", "utf8");
  await writeFile(path.join(workspaceRoot, "later.txt"), "created after checkpoint\n", "utf8");

  const result = await restoreCheckpoint(workspaceRoot, checkpoint.id);
  assert.equal(result.restored, true);

  const after = await readFile(probe, "utf8");
  assert.equal(
    (after.match(/function /g) ?? []).length,
    1,
    `the post-checkpoint edit must be reverted, got: ${JSON.stringify(after)}`,
  );
  assert.equal(after, "function alpha() {}\n", "the file must match its checkpoint content exactly");
  await assert.rejects(
    () => readFile(path.join(workspaceRoot, "later.txt"), "utf8"),
    "a file created after the checkpoint must still be removed",
  );
});

/**
 * A restore brings back files deleted after the checkpoint, tracked or not.
 *
 * The untracked half is the one that used to fail, and it fails for the same
 * reason the edited case does: no patch can describe a path git has never
 * indexed, so an untracked file that was deleted after the checkpoint had
 * nothing to restore it from. The temp-index patch carries it like any other
 * untracked file, and its absence from disk is simply "the path is not there",
 * which `git apply` creating it resolves.
 */
test("a restore brings back files deleted after the checkpoint", async () => {
  const workspaceRoot = await createTempWorkspace();
  const tracked = path.join(workspaceRoot, "src", "app.ts");
  const untracked = path.join(workspaceRoot, "scratch", "notes.txt");
  await mkdir(path.dirname(untracked), { recursive: true });
  await writeFile(untracked, "untracked notes\n", "utf8");

  const checkpoint = await createCheckpoint({ workspaceRoot, reason: "deletions" });

  // Delete both after the checkpoint: one git knows, one it has never seen.
  await rm(tracked, { force: true });
  await rm(untracked, { force: true });

  const result = await restoreCheckpoint(workspaceRoot, checkpoint.id);
  assert.equal(result.restored, true);

  assert.equal(await readFile(tracked, "utf8"), "export const answer = 41;\n", "a deleted tracked file must come back");
  assert.equal(await readFile(untracked, "utf8"), "untracked notes\n", "a deleted untracked file must come back");
});
