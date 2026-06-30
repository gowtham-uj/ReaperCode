import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ReaperSessionManager,
  continueRecentSession,
  forkSessionFromFile,
  listSessions,
  type SessionEntry,
} from "../../src/session/session-manager.js";

async function tempFile(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, "session.jsonl");
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("ReaperSessionManager.getLeafId/getEntry/getChildren/getBranch walk the tree", async () => {
  const filePath = await tempFile("reaper-session-tree-api-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const u1 = await manager.appendMessage({ role: "user", content: "u1" });
  const a1 = await manager.appendMessage({ role: "assistant", content: "a1" });
  const u2 = await manager.appendMessage({ role: "user", content: "u2" });

  assert.equal(manager.getLeafId(), u2.id);
  assert.equal(manager.getEntry(u1.id)?.id, u1.id);
  assert.deepEqual(
    manager.getChildren(manager.root.id).map((e: SessionEntry) => e.id),
    [u1.id],
  );
  assert.deepEqual(manager.getChildren(u1.id).map((e: SessionEntry) => e.id), [a1.id]);

  const branch = manager.getBranch(u2.id).map((entry) => entry.id);
  assert.deepEqual(branch, [manager.root.id, u1.id, a1.id, u2.id]);
});

test("ReaperSessionManager.branch moves the leaf and the next append becomes a child of branch point", async () => {
  const filePath = await tempFile("reaper-session-branch-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  await manager.appendMessage({ role: "user", content: "u1" });
  const a1 = await manager.appendMessage({ role: "assistant", content: "a1" });
  const u2 = await manager.appendMessage({ role: "user", content: "u2" });

  manager.branch(a1.id);
  assert.equal(manager.getLeafId(), a1.id);
  const a2 = await manager.appendMessage({ role: "assistant", content: "a2-new-branch" });
  assert.equal(a2.parentId, a1.id);

  const originalBranch = manager.getBranch(u2.id).map((e: SessionEntry) => e.id);
  const newBranch = manager.getBranch(a2.id).map((e: SessionEntry) => e.id);
  assert.equal(originalBranch.length, 4);
  assert.equal(newBranch.length, 4);
});

test("ReaperSessionManager.branchWithSummary appends a branch_summary entry and rewires the leaf", async () => {
  const filePath = await tempFile("reaper-session-branch-summary-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const u1 = await manager.appendMessage({ role: "user", content: "u1" });
  const a1 = await manager.appendMessage({ role: "assistant", content: "a1" });

  const summary = await manager.branchWithSummary(a1.id, "going a different way");
  assert.equal(summary.type, "branch_summary");
  if (summary.type !== "branch_summary") throw new Error("expected branch_summary");
  assert.equal(summary.fromId, a1.id);
  assert.equal(summary.summary, "going a different way");

  const newEntry = await manager.appendMessage({ role: "user", content: "after branch" });
  assert.equal(newEntry.parentId, summary.id);
});

test("ReaperSessionManager.resetLeaf returns the leaf to the session root", async () => {
  const filePath = await tempFile("reaper-session-reset-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  await manager.appendMessage({ role: "user", content: "u1" });
  await manager.appendMessage({ role: "assistant", content: "a1" });
  manager.resetLeaf();
  assert.equal(manager.getLeafId(), manager.root.id);
  const fresh = await manager.appendMessage({ role: "user", content: "fresh-root-child" });
  assert.equal(fresh.parentId, manager.root.id);
});

test("ReaperSessionManager.getTree returns a forest with sorted children", async () => {
  const filePath = await tempFile("reaper-session-tree-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const u1 = await manager.appendMessage({ role: "user", content: "u1" });
  await manager.appendMessage({ role: "assistant", content: "a1", parentId: u1.id });
  const u2 = await manager.appendMessage({ role: "user", content: "u2" });

  const tree = manager.getTree();
  assert.equal(tree.length, 1);
  const rootNode = tree[0]!;
  assert.equal(rootNode.entry.id, manager.root.id);
  // The tree has root -> u1 -> a1 -> u2; root only has one direct child (u1).
  assert.equal(rootNode.children.length, 1);
  const u1Node = rootNode.children[0]!;
  assert.equal(u1Node.entry.id, u1.id);
  // u1's child is a1, and a1's child is u2.
  const a1Node = u1Node.children[0]!;
  assert.equal(a1Node.children.length, 1);
  assert.equal(a1Node.children[0]!.entry.id, u2.id);
});

test("forkSessionFromFile creates a fresh session under the target directory", async () => {
  const sourcePath = await tempFile("reaper-session-fork-src-");
  const targetDir = await tempDir("reaper-session-fork-target-");

  const source = await ReaperSessionManager.create({ filePath: sourcePath, cwd: "/original" });
  await source.appendMessage({ role: "user", content: "hello" });
  await source.appendMessage({ role: "assistant", content: "hi there" });

  const fork = await forkSessionFromFile(sourcePath, targetDir, { cwd: "/forked" });
  assert.equal(fork.root.cwd, "/forked");
  assert.equal(fork.entries.length, source.entries.length);
  assert.notEqual(fork.root.id, source.root.id);
  assert.equal(fork.buildSessionContext().length, source.buildSessionContext().length);
});

test("continueRecentSession opens the newest session in a directory", async () => {
  const dir = await tempDir("reaper-session-continue-");
  const older = await ReaperSessionManager.create({ filePath: path.join(dir, "old.jsonl"), cwd: "/repo" });
  await older.appendMessage({ role: "user", content: "old" });
  // Force a newer mtime by writing a second file last.
  const newer = await ReaperSessionManager.create({ filePath: path.join(dir, "new.jsonl"), cwd: "/repo" });
  await newer.appendMessage({ role: "user", content: "new" });

  const recent = await continueRecentSession(dir);
  assert.ok(recent, "expected a recent session to be returned");
  const messages = recent!.entries.filter((e) => e.type === "message");
  assert.equal((messages[0] as { content: unknown }).content, "new");
});

test("listSessions returns SessionListEntry objects newest first", async () => {
  const dir = await tempDir("reaper-session-list-");
  const first = await ReaperSessionManager.create({ filePath: path.join(dir, "first.jsonl"), cwd: "/repo" });
  await first.appendMessage({ role: "user", content: "alpha" });
  const second = await ReaperSessionManager.create({ filePath: path.join(dir, "second.jsonl"), cwd: "/repo" });
  await second.appendMessage({ role: "user", content: "beta" });
  await second.appendMessage({ role: "assistant", content: "beta-reply" });

  const list = await listSessions(dir);
  assert.equal(list.length, 2);
  // Newest first by mtime.
  assert.equal(list[0]!.messageCount, 2);
  assert.equal(list[1]!.messageCount, 1);
  for (const entry of list) {
    assert.equal(typeof entry.id, "string");
    assert.equal(entry.cwd, "/repo");
    assert.ok(entry.modified instanceof Date);
  }
});

test("listSessions returns empty array when the directory does not exist", async () => {
  const missingDir = path.join(tmpdir(), `reaper-session-missing-${Date.now()}`);
  const list = await listSessions(missingDir);
  assert.deepEqual(list, []);
});