/**
 * What a thread delete removes, and what it refuses to touch.
 *
 * The user's requirement is that deleting a thread removes everything it owns:
 * its record, its browser state and pages, its sandbox, its workspace and its
 * session. Measured before the fix: the record and browser state went, and the
 * workspace directory with its whole session journal stayed on disk forever.
 *
 * The conditions matter as much as the deletions. A thread whose workspace is a
 * directory the user chose holds their code, so the directory must survive while
 * the thread's own state inside it does not. These tests use a real temporary
 * home so the path rules are exercised rather than mocked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ReaperThreadManager } from "../../../src/app-server/thread-manager.js";

const exists = async (p: string): Promise<boolean> => {
  try { await access(p); return true; } catch { return false; }
};

/** A manager over a throwaway data root. */
async function manager(): Promise<{ manager: ReaperThreadManager; dataRoot: string }> {
  const dataRoot = await mkdtemp(join(homedir(), ".reaper", "test-cleanup-"));
  return { manager: new ReaperThreadManager({ dataRoot }), dataRoot };
}

test("deleting a thread removes its record and its state", async () => {
  const { manager: m, dataRoot } = await manager();
  const thread = await m.startThread({ title: "cleanup", workspaceRoot: join(dataRoot, "ws") });
  const id = thread.threadId;

  // Lay down the state a real turn would leave.
  const browserDir = join(dataRoot, ".reaper", "browser");
  await mkdir(browserDir, { recursive: true });
  for (const name of [`${id}.json`, `${id}.json.pages.json`, `${id}.json.pages-owner.json`]) {
    await writeFile(join(browserDir, name), "{}");
  }

  await m.deleteThread(id);

  assert.equal(await exists(join(dataRoot, ".reaper", "app-server", "threads", `${id}.json`)), false, "the record is gone");
  assert.equal(await exists(join(browserDir, `${id}.json`)), false, "the browser state is gone");
  assert.equal(await exists(join(browserDir, `${id}.json.pages.json`)), false, "the saved page list is gone");
  assert.equal(await exists(join(browserDir, `${id}.json.pages-owner.json`)), false, "the ownership record is gone");
  assert.equal((await m.listThreads()).length, 0, "and the thread is no longer listed");
});

test("a workspace the app minted is removed whole, with its session", async () => {
  // The leak that was measured: a managed workspace and its journal survived.
  const { manager: m } = await manager();
  const workspace = await mkdtemp(join(homedir(), ".reaper", "workspaces", "w-"));
  const thread = await m.startThread({ title: "managed", workspaceRoot: workspace });
  const id = thread.threadId;
  await mkdir(join(workspace, ".reaper", "sessions", `app-${id}`), { recursive: true });
  await writeFile(join(workspace, ".reaper", "sessions", `app-${id}`, "session.jsonl"), "{}\n");
  await writeFile(join(workspace, "notes.txt"), "agent output");

  await m.deleteThread(id);

  assert.equal(await exists(workspace), false, "a workspace under the managed root is removed whole");
});

test("a workspace the user chose keeps its files but loses the thread's session", async () => {
  /*
   * The dangerous case, and the one the rule exists for. `/work` or a repository
   * is the user's code; deleting it would be catastrophic and has nothing to do
   * with clearing a conversation. The thread's own session state inside it is
   * still ours to remove.
   */
  const { manager: m } = await manager();
  const workspace = await mkdtemp(join(homedir(), "not-managed-"));
  const thread = await m.startThread({ title: "user-chosen", workspaceRoot: workspace });
  const id = thread.threadId;

  await writeFile(join(workspace, "important-code.ts"), "export const keep = true;");
  await mkdir(join(workspace, ".reaper", "sessions", `app-${id}`), { recursive: true });
  await writeFile(join(workspace, ".reaper", "sessions", `app-${id}`, "session.jsonl"), "{}\n");

  await m.deleteThread(id);

  assert.equal(await exists(join(workspace, "important-code.ts")), true, "the user's file survives");
  assert.equal(await exists(join(workspace, ".reaper", "sessions", `app-${id}`)), false, "but the thread's session is removed");
});

test("the managed workspaces root itself is never removed", async () => {
  // A thread pointed at the root would otherwise take every other thread's
  // workspace with it, which is the one way this cleanup could be destructive.
  const { manager: m } = await manager();
  const root = join(homedir(), ".reaper", "workspaces");
  const other = await mkdtemp(join(root, "sibling-"));
  const thread = await m.startThread({ title: "root", workspaceRoot: root });

  await m.deleteThread(thread.threadId);

  assert.equal(await exists(root), true, "the root survives");
  assert.equal(await exists(other), true, "and so does a sibling workspace");
});

test("the orphan sweep removes a managed workspace with no record, and keeps others", async () => {
  /*
   * The leftovers a delete cannot cover: a thread removed by another process, a
   * crash midway, an older build. Measured: thirteen empty directories survived a
   * purge that nothing would ever remove.
   */
  const { manager: m } = await manager();
  const root = join(homedir(), ".reaper", "workspaces");

  // Ours, with no record beside it: garbage.
  const orphan = await mkdtemp(join(root, "orphan-"));
  await mkdir(join(orphan, ".reaper", "sessions"), { recursive: true });
  // Empty scaffolding, also ours.
  const empty = await mkdtemp(join(root, "empty-"));
  // A directory someone put here with content and no marker: not ours to delete.
  const foreign = await mkdtemp(join(root, "foreign-"));
  await writeFile(join(foreign, "someone-elses.txt"), "keep me");

  const { removed } = await m.sweepOrphanWorkspaces();

  assert.ok(removed.includes(orphan.split("/").pop()!), "an unmarked managed workspace is swept");
  assert.ok(removed.includes(empty.split("/").pop()!), "an empty one is swept too");
  assert.equal(await exists(foreign), true, "a directory with content and no app marker is left alone");
});

test("the orphan sweep keeps a workspace whose thread still exists", async () => {
  const { manager: m } = await manager();
  const root = join(homedir(), ".reaper", "workspaces");
  const workspace = await mkdtemp(join(root, "live-"));
  const thread = await m.startThread({ title: "live", workspaceRoot: workspace });
  await mkdir(join(workspace, ".reaper", "sessions"), { recursive: true });

  await m.sweepOrphanWorkspaces();

  assert.equal(await exists(workspace), true, "a live thread's workspace is never swept");
  await m.deleteThread(thread.threadId);
  assert.equal(await exists(workspace), false, "and it goes when the thread does");
});
