/**
 * sessions-store.test.ts — smoke tests for the TUI session metadata
 * persistence layer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  saveSession,
  loadSession,
  listSessions,
  readSessionHistory,
  sessionsDir,
  ensureSessionsDir,
} from "../../../src/tui/sessions-store.js";

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "tui-sessions-"));
}

test("sessions-store: save and load a session", () => {
  const ws = tmpWorkspace();
  const meta = {
    id: "ses_abc123",
    startedAt: "2026-06-18T10:00:00.000Z",
    model: "claude-opus-4-8",
    provider: "anthropic",
    promptCount: 3,
    messageCount: 6,
    trajectoryPath: "/tmp/trajectory.jsonl",
    firstPrompt: "build me a hello world script",
  };
  saveSession(ws, meta);
  const loaded = loadSession(ws, "ses_abc123");
  assert.ok(loaded);
  assert.equal(loaded.id, meta.id);
  assert.equal(loaded.model, meta.model);
  assert.equal(loaded.firstPrompt, meta.firstPrompt);
});

test("sessions-store: load returns null for missing session", () => {
  const ws = tmpWorkspace();
  assert.equal(loadSession(ws, "ses_nope"), null);
});

test("sessions-store: listSessions returns newest first", () => {
  const ws = tmpWorkspace();
  saveSession(ws, {
    id: "ses_old",
    startedAt: "2026-06-18T09:00:00.000Z",
    model: "m", provider: "p",
    promptCount: 1, messageCount: 2,
    trajectoryPath: "/tmp/a.jsonl",
    firstPrompt: "old",
  });
  saveSession(ws, {
    id: "ses_new",
    startedAt: "2026-06-18T10:00:00.000Z",
    model: "m", provider: "p",
    promptCount: 2, messageCount: 4,
    trajectoryPath: "/tmp/b.jsonl",
    firstPrompt: "new",
  });
  const list = listSessions(ws, 10);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, "ses_new");
  assert.equal(list[1]!.id, "ses_old");
});

test("sessions-store: listSessions respects limit", () => {
  const ws = tmpWorkspace();
  for (let i = 0; i < 25; i++) {
    saveSession(ws, {
      id: `ses_${i.toString().padStart(3, "0")}`,
      startedAt: new Date(2026, 5, 18, 9, 0, i).toISOString(),
      model: "m", provider: "p",
      promptCount: 1, messageCount: 1,
      trajectoryPath: "/tmp/x.jsonl",
    });
  }
  const list = listSessions(ws, 20);
  assert.equal(list.length, 20);
});

test("sessions-store: sessionsDir + ensureSessionsDir create the dir", () => {
  const ws = tmpWorkspace();
  const dir = sessionsDir(ws);
  assert.ok(!existsSync(dir));
  ensureSessionsDir(ws);
  assert.ok(existsSync(dir));
});

test("sessions-store: readSessionHistory parses trajectory into user/assistant turns", () => {
  const ws = tmpWorkspace();
  const traj = join(ws, "traj.jsonl");
  writeFileSync(
    traj,
    [
      JSON.stringify({ kind: "user_prompt", payload: { prompt: "hi" } }),
      JSON.stringify({ kind: "assistant_message", payload: { content: "hello there" } }),
      JSON.stringify({ kind: "tool_call", tool_name: "bash", args: { cmd: "echo" } }),
      JSON.stringify({ kind: "user_prompt", payload: { prompt: "what did i just say?" } }),
      JSON.stringify({ kind: "assistant_message", content: "you said hi" }),
      JSON.stringify({ kind: "engine_turn_complete", payload: { assistantMessage: "you said hi" } }),
      "",
    ].join("\n"),
    "utf8",
  );
  const turns = readSessionHistory(traj);
  assert.ok(turns);
  assert.equal(turns!.length, 4, "two user + two assistant (engine_turn_complete dedup to one since assistant_message already emitted)");
  assert.equal(turns![0]!.role, "user");
  assert.equal(turns![0]!.content, "hi");
  assert.equal(turns![1]!.role, "assistant");
  assert.equal(turns![1]!.content, "hello there");
  assert.equal(turns![2]!.role, "user");
  assert.equal(turns![2]!.content, "what did i just say?");
  assert.equal(turns![3]!.role, "assistant");
  assert.equal(turns![3]!.content, "you said hi");
});

test("sessions-store: readSessionHistory returns null for missing file", () => {
  const ws = tmpWorkspace();
  const turns = readSessionHistory(join(ws, "does-not-exist.jsonl"));
  assert.equal(turns, null);
});

test("sessions-store: readSessionHistory tolerates blank lines and malformed JSON", () => {
  const ws = tmpWorkspace();
  const traj = join(ws, "traj.jsonl");
  writeFileSync(
    traj,
    [
      "",
      "not-json",
      JSON.stringify({ kind: "user_prompt", payload: { prompt: "ping" } }),
      "",
      JSON.stringify({}),
      "",
    ].join("\n"),
    "utf8",
  );
  const turns = readSessionHistory(traj);
  assert.ok(turns);
  assert.equal(turns!.length, 1);
  assert.equal(turns![0]!.role, "user");
  assert.equal(turns![0]!.content, "ping");
});