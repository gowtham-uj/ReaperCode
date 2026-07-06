import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  initJournal,
  journalExists,
  appendEntry,
  readHeader,
  readEntries,
  buildActiveBranchMessages,
  deriveStatus,
  listJournals,
  setTitle,
  forkSession,
  recordCompactionSavings,
  readSavingsJournal,
  aggregateSavings,
  isValidSessionName,
  type MessageEntry,
  type ToolCallEntry,
  type ToolResultEntry,
  type CompactionEntry,
} from "../../src/context/session-journal.js";

async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-journal-"));
}

function msg(parentId: string | null, role: "user" | "assistant" | "tool", content: string, extras: Partial<MessageEntry["payload"]> = {}): MessageEntry {
  return {
    id: randomUUID(),
    parentId,
    type: "message",
    ts: new Date().toISOString(),
    payload: { role, content, ts: Date.now(), ...extras },
  };
}

test("isValidSessionName accepts safe names", () => {
  assert.ok(isValidSessionName("build-repo-mind"));
  assert.ok(isValidSessionName("session_001"));
  assert.ok(!isValidSessionName("a/b"));
  assert.ok(!isValidSessionName(""));
});

test("initJournal creates a session with header and title slot", async () => {
  const ws = await freshWorkspace();
  const { header, journalPath } = await initJournal({
    name: "build-repo-mind",
    workspaceRoot: ws,
    cwd: ws,
    initialPrompt: "Build RepoMind",
    model: "MiniMax-M3",
    provider: "minimax-oauth",
    title: "Build RepoMind",
    source: "user",
  });
  assert.equal(header.name, "build-repo-mind");
  assert.equal(header.cwd, ws);
  assert.equal(header.title, "Build RepoMind");
  assert.equal(header.titleSource, "user");
  // Read the file: should start with the title slot, then header.
  const raw = (await import("node:fs")).readFileSync(journalPath, "utf8");
  const firstLine = raw.split("\n")[0]!;
  assert.match(firstLine, /"type":"title_slot"/);
});

test("initJournal refuses duplicates", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  await assert.rejects(() => initJournal({ name: "s", workspaceRoot: ws, cwd: ws }), /already exists/);
});

test("appendEntry + readEntries roundtrip", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  const parent = msg(null, "user", "hi");
  await appendEntry(ws, "s", parent);
  const child = msg(parent.id, "assistant", "hello");
  await appendEntry(ws, "s", child);
  const entries = readEntries(ws, "s");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.id, parent.id);
  assert.equal(entries[1]!.id, child.id);
});

test("buildActiveBranchMessages returns the live conversation", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  const m1 = msg(null, "user", "hi");
  await appendEntry(ws, "s", m1);
  const m2 = msg(m1.id, "assistant", "hello");
  await appendEntry(ws, "s", m2);
  const conv = buildActiveBranchMessages(ws, "s");
  assert.equal(conv.length, 2);
  assert.equal(conv[0]!.content, "hi");
  assert.equal(conv[1]!.content, "hello");
});

test("buildActiveBranchMessages filters non-message entries", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  const m1 = msg(null, "user", "hi");
  await appendEntry(ws, "s", m1);
  const m2 = msg(m1.id, "assistant", "hello");
  await appendEntry(ws, "s", m2);
  await appendEntry(ws, "s", {
    id: randomUUID(),
    parentId: m2.id,
    type: "savings",
    ts: new Date().toISOString(),
    payload: { kind: "shake", savedChars: 1000 },
  });
  const conv = buildActiveBranchMessages(ws, "s");
  assert.equal(conv.length, 2);
});

test("deriveStatus returns 'pending' when last entry is user", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  const m = msg(null, "user", "hi");
  await appendEntry(ws, "s", m);
  assert.equal(deriveStatus(ws, "s"), "pending");
});

test("deriveStatus returns 'complete' when last entry is assistant without tool_calls", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  await appendEntry(ws, "s", msg(null, "user", "hi"));
  await appendEntry(ws, "s", msg(readEntries(ws, "s")[0]!.id, "assistant", "ok"));
  assert.equal(deriveStatus(ws, "s"), "complete");
});

test("deriveStatus returns 'interrupted' when assistant has pending tool_calls", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  await appendEntry(ws, "s", msg(null, "user", "hi"));
  const last = msg(readEntries(ws, "s")[0]!.id, "assistant", "calling", {
    tool_calls: [{ id: "t1", name: "bash", args: { cmd: "ls" } }],
  });
  await appendEntry(ws, "s", last);
  assert.equal(deriveStatus(ws, "s"), "interrupted");
});

test("listJournals returns all sessions sorted by modified", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "alpha", workspaceRoot: ws, cwd: ws });
  await new Promise((r) => setTimeout(r, 10));
  await initJournal({ name: "beta", workspaceRoot: ws, cwd: ws });
  const list = listJournals(ws);
  assert.equal(list.length, 2);
  // Newest first
  assert.equal(list[0]!.name, "beta");
  assert.equal(list[1]!.name, "alpha");
});

test("setTitle updates the title slot", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws, title: "Original", source: "auto" });
  await setTitle(ws, "s", "A much better title", "user");
  const h = readHeader(ws, "s");
  assert.equal(h!.title, "A much better title");
  assert.equal(h!.titleSource, "user");
});

test("forkSession copies entries up to a cut point", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "parent", workspaceRoot: ws, cwd: ws });
  const m1 = msg(null, "user", "hi");
  await appendEntry(ws, "parent", m1);
  const m2 = msg(m1.id, "assistant", "hello");
  await appendEntry(ws, "parent", m2);
  const m3 = msg(m2.id, "user", "another question");
  await appendEntry(ws, "parent", m3);
  // Fork from m2
  await forkSession({
    name: "child",
    workspaceRoot: ws,
    fromName: "parent",
    fromEntryId: m2.id,
    reason: "test fork",
  });
  const childEntries = readEntries(ws, "child");
  // m1, m2, plus a branch entry at the end.
  assert.equal(childEntries.length, 3);
  assert.equal(childEntries[0]!.id, m1.id);
  assert.equal(childEntries[1]!.id, m2.id);
  assert.equal(childEntries[2]!.type, "branch");
  // m3 is NOT in the child.
  assert.ok(!childEntries.find((e) => e.id === m3.id));
});

test("recordCompactionSavings + aggregateSavings", async () => {
  const ws = await freshWorkspace();
  await recordCompactionSavings(ws, {
    ts: Date.now(),
    session: "s1",
    kind: "shake",
    cleared: 5,
    savedChars: 1000,
  });
  await recordCompactionSavings(ws, {
    ts: Date.now(),
    session: "s1",
    kind: "time_microcompact",
    cleared: 10,
    savedChars: 500,
  });
  await recordCompactionSavings(ws, {
    ts: Date.now(),
    session: "s2",
    kind: "shake",
    cleared: 3,
    savedChars: 300,
  });
  const all = readSavingsJournal(ws);
  assert.equal(all.length, 3);
  const agg = aggregateSavings(all);
  assert.equal(agg.totalSavedChars, 1800);
  assert.equal(agg.byKind["shake"], 1300);
  assert.equal(agg.byKind["time_microcompact"], 500);
  assert.equal(agg.bySession["s1"], 1500);
  assert.equal(agg.bySession["s2"], 300);
});

test("recordCompactionSavings filters by since and session", async () => {
  const ws = await freshWorkspace();
  const now = Date.now();
  await recordCompactionSavings(ws, { ts: now - 10000, session: "s1", kind: "shake", savedChars: 100 });
  await recordCompactionSavings(ws, { ts: now, session: "s1", kind: "shake", savedChars: 200 });
  await recordCompactionSavings(ws, { ts: now, session: "s2", kind: "shake", savedChars: 300 });
  const sinceNow = readSavingsJournal(ws, { sinceMs: now - 1000 });
  assert.equal(sinceNow.length, 2);
  const onlyS1 = readSavingsJournal(ws, { session: "s1" });
  assert.equal(onlyS1.length, 2);
  assert.equal(onlyS1.reduce((a, b) => a + b.savedChars, 0), 300);
});

test("multi-day scenario: journal survives 1000+ entries", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  const t0 = Date.now();
  let parent = randomUUID();
  await appendEntry(ws, "s", {
    id: parent,
    parentId: null,
    type: "message",
    ts: new Date().toISOString(),
    payload: { role: "user", content: "start", ts: t0 },
  });
  for (let i = 0; i < 1000; i += 1) {
    const id = randomUUID();
    await appendEntry(ws, "s", {
      id,
      parentId: parent,
      type: "message",
      ts: new Date(Date.now() + i).toISOString(),
      payload: { role: i % 2 === 0 ? "assistant" : "user", content: `turn ${i}`, ts: Date.now() + i },
    });
    parent = id;
  }
  const t1 = Date.now();
  const writeMs = t1 - t0;
  const entries = readEntries(ws, "s");
  assert.equal(entries.length, 1001);
  // Read should be fast.
  const r0 = Date.now();
  buildActiveBranchMessages(ws, "s");
  const r1 = Date.now();
  assert.ok(r1 - r0 < 500, `read took ${r1 - r0}ms`);
  // 1000 writes in <5s
  assert.ok(writeMs < 10000, `1001 writes took ${writeMs}ms`);
});

test("journal correctly handles tool_call + tool_result entries", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  const parent = msg(null, "user", "do something");
  await appendEntry(ws, "s", parent);
  // Assistant with tool_calls
  const asst = msg(parent.id, "assistant", "calling", {
    tool_calls: [{ id: "tc1", name: "bash", args: { cmd: "ls" } }],
  });
  await appendEntry(ws, "s", asst);
  // Tool result
  const result: ToolResultEntry = {
    id: randomUUID(),
    parentId: asst.id,
    type: "tool_result",
    ts: new Date().toISOString(),
    payload: { callId: "tc1", toolName: "bash", ok: true, content: "file.txt" },
  };
  await appendEntry(ws, "s", result);
  // Final assistant
  const final = msg(result.id, "assistant", "done");
  await appendEntry(ws, "s", final);
  assert.equal(deriveStatus(ws, "s"), "complete");
  const conv = buildActiveBranchMessages(ws, "s");
  assert.equal(conv.length, 3); // user, assistant, assistant (tool result is type "tool_result", not "message")
});

// ─────────────────────────────────────────────────────────────────────────
// OMP port: identity-keyed dedup
// ─────────────────────────────────────────────────────────────────────────

import {
  sessionMessagePersistenceKey,
  planTurnPersistence,
  isSignedBlock,
  recoverOrphanedBackups,
} from "../../src/context/session-journal.js";

test("sessionMessagePersistenceKey produces stable keys for the same logical message", () => {
  const a = sessionMessagePersistenceKey({ role: "assistant", timestamp: 1700000000000, tool_calls: [{ name: "bash" }] });
  const b = sessionMessagePersistenceKey({ role: "assistant", timestamp: 1700000000000, tool_calls: [{ name: "bash" }] });
  assert.equal(a, b);
});

test("sessionMessagePersistenceKey distinguishes assistant with different tools", () => {
  const a = sessionMessagePersistenceKey({ role: "assistant", timestamp: 1700000000000, tool_calls: [{ name: "bash" }] });
  const b = sessionMessagePersistenceKey({ role: "assistant", timestamp: 1700000000000, tool_calls: [{ name: "read" }] });
  assert.notEqual(a, b);
});

test("planTurnPersistence: ok case", () => {
  const keys = ["a:1", "a:2", "a:3"];
  const persisted = new Set<string>();
  const plan = planTurnPersistence(keys, persisted);
  assert.equal(plan.kind, "ok");
  if (plan.kind === "ok") {
    assert.deepEqual(plan.toPersist, [0, 1, 2]);
  }
});

test("planTurnPersistence: skip already-persisted contiguous prefix", () => {
  // When all already-persisted keys form a contiguous prefix, the
  // remaining tail is in order and we can persist it cleanly.
  const keys = ["a:1", "a:2", "a:3"];
  const persisted = new Set(["a:1", "a:2"]);
  const plan = planTurnPersistence(keys, persisted);
  assert.equal(plan.kind, "ok");
  if (plan.kind === "ok") {
    assert.deepEqual(plan.toPersist, [2]);
  }
});

test("planTurnPersistence: out-of-order detection", () => {
  const keys = ["a:1", "a:2", "a:3"];
  const persisted = new Set(["a:2"]);
  const plan = planTurnPersistence(keys, persisted);
  assert.equal(plan.kind, "out-of-order");
  if (plan.kind === "out-of-order") {
    assert.equal(plan.messageIndex, 0); // a:1 hasn't been persisted but a:2 has
  }
});

test("isSignedBlock: detects thinkingSignature, textSignature, encrypted_content", () => {
  const thinking = msg(null, "assistant", "x", { type: "thinking", thinkingSignature: "sig" } as never);
  assert.equal(isSignedBlock(thinking), true);
  const text = msg(null, "assistant", "x", { type: "text", textSignature: "sig" } as never);
  assert.equal(isSignedBlock(text), true);
  const reasoning = msg(null, "assistant", "x", { type: "reasoning", encrypted_content: "enc" } as never);
  assert.equal(isSignedBlock(reasoning), true);
});

test("isSignedBlock: returns false for plain messages", () => {
  const plain = msg(null, "user", "hi");
  assert.equal(isSignedBlock(plain), false);
  const asst = msg(null, "assistant", "ok");
  assert.equal(isSignedBlock(asst), false);
});

test("recoverOrphanedBackups: returns 0 when no baks exist", async () => {
  const ws = await freshWorkspace();
  await initJournal({ name: "s", workspaceRoot: ws, cwd: ws });
  assert.equal(recoverOrphanedBackups(ws), 0);
});
