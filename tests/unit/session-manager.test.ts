import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ReaperSessionManager,
  createSessionEntry,
  type SessionEntry,
} from "../../src/session/session-manager.js";

async function tempFile(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, "session.jsonl");
}

test("ReaperSessionManager appends entries and builds linear session context", async () => {
  const filePath = await tempFile("reaper-session-linear-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const user = await manager.appendMessage({ role: "user", content: "fix bug" });
  const assistant = await manager.appendMessage({ role: "assistant", content: "done" });

  const context = manager.buildSessionContext();
  assert.deepEqual(context.map((entry) => entry.id), [manager.root.id, user.id, assistant.id]);
  assert.equal(context.at(-1)?.parentId, user.id);

  const reloaded = await ReaperSessionManager.open(filePath);
  assert.deepEqual(reloaded.buildSessionContext().map((entry) => entry.id), context.map((entry) => entry.id));
});

test("ReaperSessionManager forks before and at selected entries", async () => {
  const filePath = await tempFile("reaper-session-fork-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const first = await manager.appendMessage({ role: "user", content: "first" });
  const second = await manager.appendMessage({ role: "assistant", content: "second" });
  const third = await manager.appendMessage({ role: "user", content: "third" });

  const before = await manager.forkBefore(third.id, { summary: "fork before third" });
  assert.equal(before.parentId, second.id);
  assert.deepEqual(manager.buildSessionContext(before.id).map((entry) => entry.id), [manager.root.id, first.id, second.id, before.id]);

  const at = await manager.forkAt(second.id, { summary: "fork at second" });
  assert.equal(at.parentId, second.id);
  assert.deepEqual(manager.buildSessionContext(at.id).map((entry) => entry.id), [manager.root.id, first.id, second.id, at.id]);
});

test("ReaperSessionManager keeps compaction summaries before retained entries", async () => {
  const filePath = await tempFile("reaper-session-compact-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  const user = await manager.appendMessage({ role: "user", content: "large task" });
  const compacted = await manager.appendCompaction({ summary: "User wants large task; tests failed once", firstKeptEntryId: user.id, tokensBefore: 12000 });
  const next = await manager.appendMessage({ role: "assistant", content: "continuing" });

  const context = manager.buildSessionContext(next.id);
  assert.equal(context.some((entry) => entry.type === "compaction" && entry.id === compacted.id), true);
  assert.equal(context.at(-1)?.id, next.id);
});

test("ReaperSessionManager skips malformed JSONL lines on open", async () => {
  const filePath = await tempFile("reaper-session-malformed-");
  const root = createSessionEntry({ type: "session", version: 1, cwd: "/repo" });
  const user = createSessionEntry({ type: "message", role: "user", content: "hello", parentId: root.id });
  await writeFile(filePath, `${JSON.stringify(root)}\nnot-json\n${JSON.stringify(user)}\n`, "utf8");

  const manager = await ReaperSessionManager.open(filePath);
  assert.deepEqual(manager.buildSessionContext(user.id).map((entry) => entry.id), [root.id, user.id]);
});

test("ReaperSessionManager exports and imports JSONL sessions", async () => {
  const filePath = await tempFile("reaper-session-export-");
  const exportedPath = await tempFile("reaper-session-import-");
  const manager = await ReaperSessionManager.create({ filePath, cwd: "/repo" });
  await manager.appendMessage({ role: "user", content: "hello" });
  await manager.exportJsonl(exportedPath);

  const raw = await readFile(exportedPath, "utf8");
  assert.match(raw, /\"type\":\"session\"/);
  const imported = await ReaperSessionManager.importJsonl(exportedPath, await tempFile("reaper-session-imported-"));
  assert.equal(imported.buildSessionContext().length, manager.buildSessionContext().length);
});
