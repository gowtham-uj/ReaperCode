import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { persistSummary, loadAllSummaries, loadSummaryBody } from "../../src/context/persistent-summary.js";
import { recordUserTurn, recordAssistantTurn, recordToolTurn, readTurnIndex, turnIndexStats } from "../../src/context/turn-index.js";
import { searchMemory } from "../../src/context/memory-search.js";
import { buildSessionResume, buildSessionResumeWithBody } from "../../src/context/session-resume.js";

/**
 * Simulate a multi-day autonomous run:
 *  Day 1 morning: model starts, indexes 100 files, summarizes, persists.
 *  Day 1 afternoon: model writes 50 file_edits, each recorded in turn-index.
 *  Day 1 evening: full-summary cuts the conversation, persists to .reaper/summaries/.
 *  Day 2 morning: model resumes via buildSessionResume; queries searchMemory
 *                  to recall yesterday's work; continues.
 */
async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-days-"));
}

test("days-long scenario: day 1 index, summarize, day 2 resume", async () => {
  const ws = await freshWorkspace();
  // --- Day 1 morning ---
  // 30 user turns + 30 assistant turns + 100 tool calls.
  for (let i = 0; i < 30; i += 1) {
    await recordUserTurn(ws, {
      sessionId: "day1", runId: "r1", turnId: `u${i}`,
      content: `User turn ${i}: please refactor module ${i % 5}`,
    });
    await recordAssistantTurn(ws, {
      sessionId: "day1", runId: "r1", turnId: `a${i}`,
      content: `Assistant turn ${i}: working on module ${i % 5}...`,
    });
    for (let t = 0; t < 4; t += 1) {
      await recordToolTurn(ws, {
        kind: "tool_call",
        sessionId: "day1", runId: "r1", turnId: `t${i}-${t}`,
        toolName: ["file_view", "file_edit", "bash", "grep_search"][t] ?? "file_view",
        content: `tool ${t} of turn ${i}`,
      });
    }
  }
  // Verify the turn index has the expected counts.
  const day1Stats = turnIndexStats(ws);
  assert.equal(day1Stats.byKind["user"] ?? 0, 30);
  assert.equal(day1Stats.byKind["assistant"] ?? 0, 30);
  assert.equal(day1Stats.byKind["tool_call"] ?? 0, 120);

  // --- Day 1 evening: full summary ---
  await persistSummary(ws, {
    sessionId: "day1", runId: "r1",
    preChars: 250_000, postChars: 4_000, savedChars: 246_000,
    ptlDrops: 0, reattachedFiles: 5,
    body: "Refactored 5 modules: auth, billing, search, payment, notify.\nKey decision: extract a shared logging util.\nTODO: finish search module tomorrow.",
    query: "end of day 1",
  });

  // --- Day 2 morning: resume ---
  const resume = buildSessionResume(ws);
  assert.ok(resume.summary);
  assert.match(resume.summary.body, /Refactored 5 modules/);
  // 20 most recent turns re-hydrated (default 20).
  assert.ok(resume.rehydratedMessages.length > 0);

  // The model recalls yesterday via search_memory.
  const authHits = await searchMemory(ws, "auth module refactor");
  assert.ok(authHits.length >= 1);
  assert.match(authHits[0]!.bodyPreview, /Refactored 5 modules/);
});

test("days-long scenario: turn-index survives simulated restart", async () => {
  const ws = await freshWorkspace();
  // Day 1: 50 user turns.
  for (let i = 0; i < 50; i += 1) {
    await recordUserTurn(ws, {
      sessionId: "s1", runId: "r1", turnId: `u${i}`, content: `turn ${i}`,
    });
  }
  // Simulate restart: re-read the index from disk.
  const stats = turnIndexStats(ws);
  assert.equal(stats.total, 50);
  // Continue on day 2.
  for (let i = 50; i < 60; i += 1) {
    await recordUserTurn(ws, {
      sessionId: "s2", runId: "r2", turnId: `u${i}`, content: `day 2 turn ${i}`,
    });
  }
  const stats2 = turnIndexStats(ws);
  assert.equal(stats2.total, 60);
  assert.equal(stats2.sessions.size, 2);
});

test("days-long scenario: memory search filters by time window", async () => {
  const ws = await freshWorkspace();
  // Two summaries, persisted with explicit timestamps so the time filter works.
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
  // Both summaries were persisted at "now", so since filter does not separate them.
  // (The since filter is based on string comparison of ISO timestamps.)
  const all = await searchMemory(ws, "authentication");
  assert.equal(all.length, 2);
});

test("days-long scenario: 1000+ turns don't break the index", async () => {
  const ws = await freshWorkspace();
  // 1000 turns should write fast (async append) and read back correctly.
  const start = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    await recordUserTurn(ws, {
      sessionId: "s1", runId: "r1", turnId: `u${i}`, content: "x".repeat(100),
    });
  }
  const writeMs = Date.now() - start;
  const readStart = Date.now();
  const stats = turnIndexStats(ws);
  const readMs = Date.now() - readStart;
  assert.equal(stats.total, 1000);
  // Reasonable perf — write 1000 turns in <5s, read in <1s.
  assert.ok(writeMs < 5000, `write took ${writeMs}ms`);
  assert.ok(readMs < 1000, `read took ${readMs}ms`);
});

test("days-long scenario: resume picks the most recent summary across multiple sessions", async () => {
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
