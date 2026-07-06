import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  recordUserTurn,
  recordAssistantTurn,
  recordToolTurn,
  readTurnIndex,
  turnIndexStats,
} from "../../src/context/turn-index.js";

async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-turntest-"));
}

test("recordUserTurn appends a row to the index", async () => {
  const ws = await freshWorkspace();
  await recordUserTurn(ws, {
    sessionId: "s1", runId: "r1", turnId: "t1", content: "hello world",
  });
  const rows = readTurnIndex(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "user");
  assert.equal(rows[0]!.chars, 11);
  assert.match(rows[0]!.content_sha ?? "", /^[a-f0-9]{16}$/);
});

test("recordAssistantTurn records the message", async () => {
  const ws = await freshWorkspace();
  await recordAssistantTurn(ws, {
    sessionId: "s1", runId: "r1", turnId: "t1",
    content: "I'll start by reading the file",
  });
  const rows = readTurnIndex(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "assistant");
});

test("recordToolTurn captures tool_name and ok", async () => {
  const ws = await freshWorkspace();
  await recordToolTurn(ws, {
    kind: "tool_call",
    sessionId: "s1", runId: "r1", turnId: "t1",
    toolName: "file_view", content: "file_view src/x.ts",
  });
  await recordToolTurn(ws, {
    kind: "tool_result",
    sessionId: "s1", runId: "r1", turnId: "t1",
    toolName: "file_view", content: "abc", ok: true,
  });
  const rows = readTurnIndex(ws);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "tool_call");
  assert.equal(rows[0]!.tool_name, "file_view");
  assert.equal(rows[1]!.kind, "tool_result");
  assert.equal(rows[1]!.ok, true);
});

test("readTurnIndex filters by sessionId, kind, since", async () => {
  const ws = await freshWorkspace();
  await recordUserTurn(ws, { sessionId: "s1", runId: "r1", turnId: "t1", content: "hi" });
  await recordUserTurn(ws, { sessionId: "s2", runId: "r1", turnId: "t1", content: "hi" });
  await recordAssistantTurn(ws, { sessionId: "s1", runId: "r1", turnId: "t1", content: "ok" });
  const s1Only = readTurnIndex(ws, { sessionId: "s1" });
  assert.equal(s1Only.length, 2);
  const userOnly = readTurnIndex(ws, { kind: "user" });
  assert.equal(userOnly.length, 2);
});

test("readTurnIndex newestFirst returns reverse order", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 5; i += 1) {
    await recordUserTurn(ws, { sessionId: "s1", runId: "r1", turnId: `t${i}`, content: `turn ${i}` });
  }
  const newest = readTurnIndex(ws, { newestFirst: true });
  assert.equal(newest[0]!.turn_id, "t4");
  assert.equal(newest[4]!.turn_id, "t0");
});

test("turnIndexStats summarizes the index", async () => {
  const ws = await freshWorkspace();
  await recordUserTurn(ws, { sessionId: "s1", runId: "r1", turnId: "t1", content: "hello" });
  await recordUserTurn(ws, { sessionId: "s1", runId: "r1", turnId: "t2", content: "world" });
  await recordToolTurn(ws, {
    kind: "tool_call",
    sessionId: "s1", runId: "r1", turnId: "t2",
    toolName: "bash", content: "ls",
  });
  const stats = turnIndexStats(ws);
  assert.equal(stats.total, 3);
  assert.equal(stats.byKind["user"], 2);
  assert.equal(stats.byKind["tool_call"], 1);
  assert.equal(stats.totalChars, 5 + 5 + 2);
  assert.equal(stats.sessions.size, 1);
});

test("readTurnIndex honors maxRows", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 20; i += 1) {
    await recordUserTurn(ws, { sessionId: "s1", runId: "r1", turnId: `t${i}`, content: "x" });
  }
  const top10 = readTurnIndex(ws, { maxRows: 10 });
  assert.equal(top10.length, 10);
});
