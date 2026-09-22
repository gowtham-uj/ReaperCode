/**
 * A thread whose workspace was destroyed must not survive as a row.
 *
 * Reported live: the sidebar listed a conversation, clicking it loaded nothing,
 * and it could not be removed because every action on it failed the same way.
 * Two faults produced that state, and each is asserted here.
 *
 *   1. The boot sweep deleted a workspace that held a conversation. The record
 *      survived, so the thread still looked real while every turn in it was gone.
 *   2. `listThreads` did not check, so a record with no workspace was listed
 *      anyway.
 *
 * The first is the serious one: deleting a conversation is irreversible, and a
 * housekeeping pass is the last thing that should ever do it. The second is what
 * made it visible to a user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ReaperThreadManager } from "../../../src/app-server/thread-manager.js";

const exists = async (p: string): Promise<boolean> => {
  try { await readdir(p); return true; } catch { return false; }
};

/** A manager over a throwaway data root, with the real workspaces root untouched. */
async function manager(): Promise<ReaperThreadManager> {
  const dataRoot = await mkdtemp(join(tmpdir(), "zombie-"));
  return new ReaperThreadManager({ dataRoot });
}

test("the sweep leaves a workspace that holds a conversation", async () => {
  /*
   * The data-loss guard. A workspace with a session journal is a conversation
   * somebody had, whatever the thread records say. This pass must not be the
   * thing that destroys it, so it steps over any directory that holds one.
   *
   * The sweep reads the real `~/.reaper/workspaces` root, so the fixture is laid
   * down there and removed afterwards. The manager is pointed at a separate data
   * root, which is the interesting case: the sweep runs at boot before any thread
   * record is loaded, so "the record is not in this manager's set" is exactly the
   * state that deleted the live workspace.
   */
  const root = join(homedir(), ".reaper", "workspaces");
  const id = `zombie-keep-${process.pid}-${Date.now().toString(36)}`;
  const workspace = join(root, id);
  await mkdir(join(workspace, ".reaper", "sessions", `app-${id}`), { recursive: true });
  await writeFile(join(workspace, ".reaper", "sessions", `app-${id}`, "session.jsonl"), "{}\n");
  try {
    const m = await manager();
    const result = await m.sweepOrphanWorkspaces();
    assert.equal(await exists(workspace), true, "a workspace holding a journal must survive the sweep");
    assert.equal(result.removed.includes(id), false, "and must not be reported as removed");
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(workspace, { recursive: true, force: true }));
  }
});

test("the sweep still removes an empty scaffolding directory", async () => {
  /*
   * The guard must not disable the pass. An empty workspace is the scaffolding
   * `createThreadWorkspace` makes for a thread that ran nothing, and collecting
   * those is the sweep's actual job. Without this the fix would read as "the
   * sweep stopped working".
   */
  const root = join(homedir(), ".reaper", "workspaces");
  const id = `zombie-empty-${process.pid}-${Date.now().toString(36)}`;
  const workspace = join(root, id);
  await mkdir(workspace, { recursive: true });
  try {
    const m = await manager();
    const result = await m.sweepOrphanWorkspaces();
    assert.equal(await exists(workspace), false, "an empty workspace is removed");
    assert.equal(result.removed.includes(id), true, "and reported");
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(workspace, { recursive: true, force: true }));
  }
});

test("a thread whose app-managed workspace is gone is not listed", async () => {
  /*
   * The zombie row. The record is real and the workspace is not, which is the
   * state that produced a sidebar entry nothing could open and nothing could
   * delete.
   *
   * The path has to be under the managed root for this to apply, because that is
   * the only kind the app creates and would have kept: a missing directory there
   * means the thread is genuinely gone. A user-chosen path is covered by the test
   * below, which asserts the opposite.
   */
  const dataRoot = await mkdtemp(join(tmpdir(), "zombie-list-"));
  const m = new ReaperThreadManager({ dataRoot });
  const managed = join(homedir(), ".reaper", "workspaces", `zombie-${process.pid}-${Date.now().toString(36)}`);

  const dead = await m.startThread({ title: "gone", workspaceRoot: managed });
  // Never created, which is the state the deleted-workspace failure left behind.
  assert.equal(await exists(managed), false);

  const live = await m.startThread({ title: "fine", workspaceRoot: join(dataRoot, "present") });
  await mkdir(join(dataRoot, "present"), { recursive: true });

  const ids = (await m.listThreads()).map((entry) => entry.threadId);
  assert.equal(ids.includes(dead.threadId), false, "a thread whose own workspace is gone must not be listed");
  assert.equal(ids.includes(live.threadId), true, "a healthy thread is still listed");
});

test("a thread in a user-chosen workspace is listed even when the path is absent", async () => {
  /*
   * The safety boundary, and the reason the check is scoped to managed paths.
   * A workspace the user typed is theirs: `/work`, a repository, a mount that is
   * not up yet. Reporting those on the strength of a `stat` would hide somebody's
   * conversation over a missing mount or a renamed checkout, so they are always
   * listed and the reader gets a row that can be retried.
   */
  const dataRoot = await mkdtemp(join(tmpdir(), "zombie-user-"));
  const m = new ReaperThreadManager({ dataRoot });
  const chosen = join(dataRoot, "not-created-yet");
  const thread = await m.startThread({ title: "user path", workspaceRoot: chosen });
  const ids = (await m.listThreads()).map((entry) => entry.threadId);
  assert.equal(ids.includes(thread.threadId), true, "a user-chosen workspace is never hidden by a missing path");
});

test("a thread the list hides cannot be resumed either", async () => {
  /*
   * The two disagreed, and the disagreement was the visible bug.
   *
   * `listThreads` filtered out a thread whose app-managed workspace was gone,
   * while `thread/resume` on the same id succeeded. The client remembers the id
   * of the last thread you opened, so on the next load it resumed it and rendered
   * it in the main area: an empty sidebar beside an open conversation whose every
   * command failed, because the directory its sandbox was built from no longer
   * existed. Reported exactly that way.
   *
   * Asserted as an agreement rather than as two separate behaviours, because the
   * property that matters is that the two answers match. Either one changing
   * alone is the bug.
   */
  const dataRoot = await mkdtemp(join(tmpdir(), "zombie-resume-"));
  const m = new ReaperThreadManager({ dataRoot });
  const managed = join(homedir(), ".reaper", "workspaces", `zombie-resume-${process.pid}-${Date.now().toString(36)}`);
  const dead = await m.startThread({ title: "gone", workspaceRoot: managed });
  assert.equal(await exists(managed), false, "the fixture is the state: a record whose workspace was never made");

  const listed = (await m.listThreads()).map((entry) => entry.threadId);
  assert.equal(listed.includes(dead.threadId), false, "the list hides it");

  await assert.rejects(
    () => m.resumeThread(dead.threadId),
    /not found/,
    "and resume must refuse it with the same answer, or a remembered id restores a dead thread",
  );
});

test("a live thread still resumes, so the guard is not a blanket refusal", async () => {
  /* The other direction, so the fix cannot pass by refusing everything. */
  const dataRoot = await mkdtemp(join(tmpdir(), "zombie-live-"));
  const m = new ReaperThreadManager({ dataRoot });
  const present = join(dataRoot, "present");
  await mkdir(present, { recursive: true });
  const thread = await m.startThread({ title: "fine", workspaceRoot: present });
  const resumed = await m.resumeThread(thread.threadId);
  assert.equal(resumed.threadId, thread.threadId);
});
