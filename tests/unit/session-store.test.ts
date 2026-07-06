import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSession,
  loadSession,
  listSessions,
  deleteSession,
  isValidSessionName,
  appendSessionMessage,
  loadSessionConversation,
  recordSessionRun,
  updateSessionMetadata,
} from "../../src/context/session-store.js";

async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-session-"));
}

test("isValidSessionName accepts safe names, rejects others", () => {
  assert.ok(isValidSessionName("build-repo-mind"));
  assert.ok(isValidSessionName("session_001"));
  assert.ok(isValidSessionName("test.run"));
  assert.ok(!isValidSessionName(""));
  assert.ok(!isValidSessionName("a/b"));
  assert.ok(!isValidSessionName("a b"));
  assert.ok(!isValidSessionName("name with spaces"));
});

test("createSession creates the directory tree and metadata", async () => {
  const ws = await freshWorkspace();
  const meta = await createSession({
    name: "build-repo-mind",
    workspaceRoot: ws,
    initialPrompt: "Build RepoMind end-to-end",
    model: "MiniMax-M3",
    provider: "minimax-oauth",
  });
  assert.equal(meta.name, "build-repo-mind");
  assert.ok(meta.id);
  assert.match(meta.createdAt, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(meta.status, "active");
  assert.equal(meta.runCount, 0);
  // Directory exists
  const sessionDir = path.join(ws, ".reaper", "sessions", "build-repo-mind");
  const { existsSync, statSync } = await import("node:fs");
  assert.ok(existsSync(sessionDir));
  assert.ok(existsSync(path.join(sessionDir, "session.json")));
  assert.ok(existsSync(path.join(sessionDir, "summaries")));
  assert.ok(existsSync(path.join(sessionDir, "state")));
});

test("createSession refuses duplicates", async () => {
  const ws = await freshWorkspace();
  await createSession({ name: "s", workspaceRoot: ws, initialPrompt: "hi" });
  await assert.rejects(
    () => createSession({ name: "s", workspaceRoot: ws, initialPrompt: "hi again" }),
    /already exists/,
  );
});

test("loadSession returns null for unknown names", async () => {
  const ws = await freshWorkspace();
  const meta = await loadSession(ws, "does-not-exist");
  assert.equal(meta, null);
});

test("appendSessionMessage + loadSessionConversation roundtrips", async () => {
  const ws = await freshWorkspace();
  await createSession({ name: "s", workspaceRoot: ws, initialPrompt: "hi" });
  await appendSessionMessage(ws, "s", { role: "user", content: "hi", timestamp: Date.now() });
  await appendSessionMessage(ws, "s", { role: "assistant", content: "hello", timestamp: Date.now() });
  const conv = loadSessionConversation(ws, "s");
  assert.equal(conv.length, 2);
  assert.equal(conv[0]!.role, "user");
  assert.equal(conv[1]!.content, "hello");
});

test("listSessions returns all sessions sorted by lastActiveAt", async () => {
  const ws = await freshWorkspace();
  await createSession({ name: "alpha", workspaceRoot: ws, initialPrompt: "a" });
  await new Promise((r) => setTimeout(r, 10));
  await createSession({ name: "beta", workspaceRoot: ws, initialPrompt: "b" });
  const list = listSessions(ws);
  assert.equal(list.length, 2);
  // Newest first by default
  assert.equal(list[0]!.name, "beta");
  assert.equal(list[1]!.name, "alpha");
});

test("recordSessionRun increments runCount and updates metadata", async () => {
  const ws = await freshWorkspace();
  await createSession({ name: "s", workspaceRoot: ws, initialPrompt: "p" });
  await recordSessionRun(ws, "s", {
    runId: "r1",
    startedAt: "2026-07-05T00:00:00.000Z",
    endedAt: "2026-07-05T00:01:00.000Z",
    status: "completed",
    modelCalls: 5,
    toolCalls: 12,
    prompt: "first run",
  });
  const meta = await loadSession(ws, "s");
  assert.equal(meta!.runCount, 1);
  assert.equal(meta!.totalModelCalls, 5);
  assert.equal(meta!.totalToolCalls, 12);
  assert.equal(meta!.status, "active");
});

test("recordSessionRun records multiple runs", async () => {
  const ws = await freshWorkspace();
  await createSession({ name: "s", workspaceRoot: ws, initialPrompt: "p" });
  for (let i = 0; i < 3; i += 1) {
    await recordSessionRun(ws, "s", {
      runId: `r${i}`,
      startedAt: `2026-07-05T00:0${i}:00.000Z`,
      endedAt: `2026-07-05T00:0${i + 1}:00.000Z`,
      status: "completed",
      modelCalls: 1,
      toolCalls: 1,
      prompt: `run ${i}`,
    });
  }
  const meta = await loadSession(ws, "s");
  assert.equal(meta!.runCount, 3);
  assert.equal(meta!.totalModelCalls, 3);
  assert.equal(meta!.totalToolCalls, 3);
});

test("deleteSession removes the directory and updates the index", async () => {
  const ws = await freshWorkspace();
  await createSession({ name: "s", workspaceRoot: ws, initialPrompt: "p" });
  await appendSessionMessage(ws, "s", { role: "user", content: "x" });
  await deleteSession(ws, "s");
  const meta = await loadSession(ws, "s");
  assert.equal(meta, null);
  const list = listSessions(ws);
  assert.equal(list.length, 0);
});

test("multi-day scenario: create, do work, exit, reopen, verify", async () => {
  const ws = await freshWorkspace();
  // Day 1
  await createSession({
    name: "build-repo-mind",
    workspaceRoot: ws,
    initialPrompt: "Build RepoMind",
    model: "MiniMax-M3",
    provider: "minimax-oauth",
  });
  for (let i = 0; i < 5; i += 1) {
    await appendSessionMessage(ws, "build-repo-mind", {
      role: "user",
      content: `Day 1 turn ${i}`,
      timestamp: Date.now(),
    });
  }
  await recordSessionRun(ws, "build-repo-mind", {
    runId: "r1",
    startedAt: "2026-07-04T00:00:00.000Z",
    endedAt: "2026-07-04T01:00:00.000Z",
    status: "completed",
    modelCalls: 10,
    toolCalls: 30,
    prompt: "Build RepoMind",
  });
  // Day 2 — reopen the same name
  const meta = await loadSession(ws, "build-repo-mind");
  assert.ok(meta);
  const conv = loadSessionConversation(ws, "build-repo-mind");
  assert.equal(conv.length, 5);
  // The model can continue from here.
  await appendSessionMessage(ws, "build-repo-mind", {
    role: "user",
    content: "Day 2: continue from where you left off",
    timestamp: Date.now(),
  });
  await recordSessionRun(ws, "build-repo-mind", {
    runId: "r2",
    startedAt: "2026-07-05T00:00:00.000Z",
    endedAt: "2026-07-05T01:00:00.000Z",
    status: "completed",
    modelCalls: 8,
    toolCalls: 24,
    prompt: "Day 2: continue from where you left off",
  });
  const finalMeta = await loadSession(ws, "build-repo-mind");
  assert.equal(finalMeta!.runCount, 2);
  assert.equal(finalMeta!.totalModelCalls, 18);
  assert.equal(finalMeta!.totalToolCalls, 54);
  const finalConv = loadSessionConversation(ws, "build-repo-mind");
  assert.equal(finalConv.length, 6);
  assert.equal(finalConv[5]!.content, "Day 2: continue from where you left off");
});
