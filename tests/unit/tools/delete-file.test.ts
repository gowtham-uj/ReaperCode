/**
 * `delete_file` had no test of its own, and the guard it did have covered the
 * wrong thing.
 *
 * `assertDeletablePath` checked the workspace root and three protected
 * basenames — both of which protect the *sandbox*, not the user's work. The one
 * thing it never checked was whether the path was a file. So
 * `delete_file({ path: "src" })` ran `rm(…, { recursive: true })` over an
 * entire directory tree, removed files the call never named, and answered
 * `{ deleted: true }` — a reply indistinguishable from deleting one file.
 *
 * That is the largest irreversible action in the tool set, and it had the
 * weakest guard. The tests below assert on what survives on disk, not only on
 * the returned envelope, because the defect was precisely a return value that
 * said "fine" while the disk said otherwise.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deleteFileTool } from "../../../src/tools/write/delete-file.js";
import { ToolExecutor } from "../../../src/tools/executor.js";
import { WriteAheadLog } from "../../../src/recovery/wal.js";

async function workspaceWithTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-delete-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "nested", "b.ts"), "export const b = 2;\n", "utf8");
  return root;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

test("delete_file refuses a directory and leaves its contents on disk", async () => {
  const workspace = await workspaceWithTree();
  try {
    await assert.rejects(
      () => deleteFileTool(workspace, { path: "src" }),
      (error: unknown) => {
        assert.equal(errorCode(error), "invalid_argument");
        assert.match(String((error as Error).message), /is a directory/);
        assert.match(String((error as Error).message), /list_directory/, "the model needs a next step");
        return true;
      },
    );

    // The assertion that matters. Before the fix both files were gone, and
    // `src/nested/b.ts` was never named in the call.
    assert.ok(existsSync(path.join(workspace, "src", "a.ts")), "a.ts was deleted by a refused call");
    assert.ok(existsSync(path.join(workspace, "src", "nested", "b.ts")), "a nested file was deleted by a refused call");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_file still deletes a single file", async () => {
  // The guard must not turn the tool into a no-op. A fix that refused
  // everything would pass the test above and break the feature.
  const workspace = await workspaceWithTree();
  try {
    const result = await deleteFileTool(workspace, { path: "src/a.ts" });

    assert.equal(result.deleted, true);
    assert.equal(existsSync(path.join(workspace, "src", "a.ts")), false, "the file was not deleted");
    assert.ok(existsSync(path.join(workspace, "src", "nested", "b.ts")), "a sibling was collaterally deleted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_file refuses the workspace root", async () => {
  const workspace = await workspaceWithTree();
  try {
    await assert.rejects(() => deleteFileTool(workspace, { path: "." }), /workspace root/);
    assert.ok(existsSync(path.join(workspace, "src", "a.ts")), "the workspace was wiped");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("delete_file refuses the protected basenames", async () => {
  const workspace = await workspaceWithTree();
  try {
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    await assert.rejects(() => deleteFileTool(workspace, { path: ".git" }), /protected path/);

    assert.ok(existsSync(path.join(workspace, ".git", "HEAD")), "the repo metadata was deleted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deleting a path that does not exist stays a no-op", async () => {
  // `force: true` has always made this succeed, and callers rely on it: a
  // model that deletes a file twice should not be told the second call failed.
  const workspace = await workspaceWithTree();
  try {
    const result = await deleteFileTool(workspace, { path: "src/nope.ts" });
    assert.equal(result.deleted, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the write-ahead log refuses to stage a directory delete", async () => {
  // The executor guards the staging call, but the WAL is what runs
  // `rm(…, { recursive: true })` at flush time, and its guard previously lived
  // one stack frame away in another file. Reaching `stageDelete` by any other
  // route — a future caller, a test harness, a repair path — destroyed the tree
  // exactly as the direct route did: `src/a.ts` and `src/nested/b.ts` both gone.
  const workspace = await workspaceWithTree();
  try {
    const wal = new WriteAheadLog(workspace);

    await assert.rejects(
      () => wal.stageDelete("src"),
      (error: unknown) => {
        assert.equal(errorCode(error), "invalid_argument");
        return true;
      },
    );

    // Refusing at the staging boundary means nothing was recorded, so a flush
    // has nothing to delete. Both assertions matter: a guard that threw *after*
    // recording the entry would leave the delete queued.
    assert.equal(wal.hasEntries(), false, "a refused delete was still staged");
    assert.deepEqual(await wal.flush(), { written: 0, deleted: 0 });
    assert.ok(existsSync(path.join(workspace, "src", "nested", "b.ts")), "the tree was deleted on flush");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the write-ahead log still stages and flushes a single-file delete", async () => {
  const workspace = await workspaceWithTree();
  try {
    const wal = new WriteAheadLog(workspace);
    await wal.stageDelete("src/a.ts");
    assert.equal(await wal.hasEntry("src/a.ts"), true);
    await wal.flush();

    assert.equal(existsSync(path.join(workspace, "src", "a.ts")), false, "the file was not deleted");
    assert.ok(existsSync(path.join(workspace, "src", "nested", "b.ts")), "a sibling was collaterally deleted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the executor refuses a directory too, on both the disk and staged routes", async () => {
  // The direct call above is not the only way in. The executor also reaches
  // `assertDeletablePath` for the WAL-staged route, and a `rm` downstream of a
  // stage is the same recursive delete once the WAL flushes. Guarding one route
  // and not the other is exactly how this bug would survive its own fix.
  const workspace = await workspaceWithTree();
  try {
    const executor = new ToolExecutor({
      workspaceRoot: workspace,
      runId: "delete-guard-run",
      sessionId: "delete-guard-session",
      traceId: "delete-guard-trace",
      logLevel: "info",
      safetyProfile: "allow_all",
    });

    const result = await executor.execute({ id: "d1", name: "delete_file", args: { path: "src" } });

    assert.equal(result.ok, false, "the executor deleted a directory tree");
    assert.equal(result.error?.code, "invalid_argument");
    assert.ok(existsSync(path.join(workspace, "src", "nested", "b.ts")), "the executor deleted a nested file");
    assert.equal(
      await readFile(path.join(workspace, "src", "a.ts"), "utf8"),
      "export const a = 1;\n",
      "a file was modified or removed by a refused delete",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
