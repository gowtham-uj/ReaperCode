import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { persistSummary } from "../../src/context/persistent-summary.js";
import { searchMemory } from "../../src/context/memory-search.js";
import { buildSessionResume } from "../../src/context/session-resume.js";
import {
  initJournal,
  appendEntry,
  lastEntryId,
  buildActiveBranchMessages,
} from "../../src/context/session-journal.js";

/**
 * Simulate a multi-day autonomous run on the UNIFIED session mechanism:
 *  Day 1: many exec runs journal their turns into a named session.
 *  Day 1 evening: a full-summary compaction is written back to the journal.
 *  Day 2: the session rehydrates summary + raw tail; memory search recalls
 *         the persisted summaries.
 */
async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-days-"));
}

async function appendMessage(ws: string, name: string, role: "user" | "assistant", content: string): Promise<void> {
  await appendEntry(ws, name, {
    id: randomUUID(),
    parentId: lastEntryId(ws, name),
    type: "message",
    ts: new Date().toISOString(),
    payload: { role, content, ts: Date.now() },
  });
}

test("days-long scenario: day 1 journal, compact, day 2 rehydrate summary + tail", async () => {
  const ws = await freshWorkspace();
  const name = "days-long";
  await initJournal({ name, workspaceRoot: ws, cwd: ws });

  // --- Day 1: 30 exchanges journaled by exec runs ---
  for (let i = 0; i < 30; i += 1) {
    await appendMessage(ws, name, "user", `User turn ${i}: please refactor module ${i % 5}`);
    await appendMessage(ws, name, "assistant", `Assistant turn ${i}: refactored module ${i % 5}`);
  }
  assert.equal(buildActiveBranchMessages(ws, name).length, 60);

  // --- Day 1 evening: full_summary write-back (what onRunComplete does) ---
  await appendEntry(ws, name, {
    id: randomUUID(),
    parentId: lastEntryId(ws, name),
    type: "compaction",
    ts: new Date().toISOString(),
    note: "full_summary write-back",
    payload: {
      preChars: 250_000,
      postChars: 4_000,
      savedChars: 246_000,
      resultsShaken: 0,
      summary:
        "Refactored 5 modules: auth, billing, search, payment, notify.\n" +
        "Key decision: extract a shared logging util.\nTODO: finish search module tomorrow.",
    },
  });
  // Post-compaction turns (the run's own final exchange).
  await appendMessage(ws, name, "user", "Wrap up for today.");
  await appendMessage(ws, name, "assistant", "Done for day 1; search module remains.");

  // --- Day 2: rehydration = summary anchor + raw tail only ---
  const rehydrated = buildActiveBranchMessages(ws, name);
  assert.equal(rehydrated.length, 3, "summary anchor + 2 raw tail turns");
  assert.match(rehydrated[0]!.content, /Prior session context \(compacted\)/);
  assert.match(rehydrated[0]!.content, /Refactored 5 modules/);
  assert.match(rehydrated[2]!.content, /day 1/);
  // The 60 pre-compaction turns are summary-mediated, not raw.
  assert.ok(!rehydrated.some((m) => m.content.includes("User turn 0:")));

  // --- Day 2: memory search recalls the workspace summaries ---
  await persistSummary(ws, {
    sessionId: "day1", runId: "r1",
    preChars: 250_000, postChars: 4_000, savedChars: 246_000,
    ptlDrops: 0, reattachedFiles: 5,
    body: "Refactored 5 modules: auth, billing, search, payment, notify.",
    query: "end of day 1",
  });
  const authHits = await searchMemory(ws, "auth module refactor");
  assert.ok(authHits.length >= 1);
  assert.match(authHits[0]!.bodyPreview, /Refactored 5 modules/);
});

test("days-long scenario: journal survives simulated restart", async () => {
  const ws = await freshWorkspace();
  const name = "restart";
  await initJournal({ name, workspaceRoot: ws, cwd: ws });
  for (let i = 0; i < 50; i += 1) {
    await appendMessage(ws, name, "user", `turn ${i}`);
  }
  // Simulate restart: everything is re-read from disk on each call.
  assert.equal(buildActiveBranchMessages(ws, name).length, 50);
  for (let i = 50; i < 60; i += 1) {
    await appendMessage(ws, name, "user", `day 2 turn ${i}`);
  }
  assert.equal(buildActiveBranchMessages(ws, name).length, 60);
});

test("days-long scenario: 1000+ journal turns stay fast", async () => {
  const ws = await freshWorkspace();
  const name = "perf";
  await initJournal({ name, workspaceRoot: ws, cwd: ws });
  const start = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    await appendMessage(ws, name, "user", "x".repeat(100));
  }
  const writeMs = Date.now() - start;
  const readStart = Date.now();
  const count = buildActiveBranchMessages(ws, name).length;
  const readMs = Date.now() - readStart;
  assert.equal(count, 1000);
  assert.ok(writeMs < 30_000, `write took ${writeMs}ms`);
  assert.ok(readMs < 1_000, `read took ${readMs}ms`);
});

test("days-long scenario: memory search sees all persisted summaries", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 100, postChars: 50, savedChars: 50,
    ptlDrops: 0, reattachedFiles: 0,
    body: "old work on authentication",
  });
  await persistSummary(ws, {
    sessionId: "s1", runId: "r2",
    preChars: 100, postChars: 50, savedChars: 50,
    ptlDrops: 0, reattachedFiles: 0,
    body: "recent work on authentication",
  });
  const all = await searchMemory(ws, "authentication");
  assert.equal(all.length, 2);
});

test("days-long scenario: resume picks the most recent summary across sessions", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 5; i += 1) {
    await persistSummary(ws, {
      sessionId: `s${i}`, runId: `r${i}`,
      preChars: 100, postChars: 50, savedChars: 50,
      ptlDrops: 0, reattachedFiles: 0,
      body: `summary ${i}`,
    });
  }
  const r = buildSessionResume(ws);
  assert.ok(r.summary);
  assert.match(r.summary.body, /summary 4/);
  assert.equal(r.stats.summariesAvailable, 5);
});
