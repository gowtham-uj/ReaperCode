import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSessionResume, buildSessionResumeWithBody } from "../../src/context/session-resume.js";
import { persistSummary } from "../../src/context/persistent-summary.js";
import { recordUserTurn, recordToolTurn, recordAssistantTurn } from "../../src/context/turn-index.js";

async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-resumetest-"));
}

test("buildSessionResume with no prior data returns a minimal re-anchor", async () => {
  const ws = await freshWorkspace();
  const r = buildSessionResume(ws);
  assert.match(r.reAnchor, /No persistent summary/);
  assert.equal(r.rehydratedMessages.length, 0);
  assert.equal(r.summary, null);
  assert.equal(r.stats.summariesAvailable, 0);
});

test("buildSessionResume picks up the most recent summary", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 1000, postChars: 200, savedChars: 800,
    ptlDrops: 0, reattachedFiles: 3,
    body: "alpha\nbeta\ngamma",
  });
  await persistSummary(ws, {
    sessionId: "s1", runId: "r2",
    preChars: 500, postChars: 100, savedChars: 400,
    ptlDrops: 0, reattachedFiles: 1,
    body: "delta\nepsilon",
  });
  const r = buildSessionResume(ws);
  assert.ok(r.summary);
  assert.match(r.reAnchor, /Most recent persistent summary/);
  // preview includes "delta" (from the latest summary)
  assert.match(r.reAnchor, /delta/);
});

test("buildSessionResume re-hydrates recent turns", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 5; i += 1) {
    await recordUserTurn(ws, { sessionId: "s1", runId: "r1", turnId: `t${i}`, content: `turn ${i}` });
  }
  await recordAssistantTurn(ws, {
    sessionId: "s1", runId: "r1", turnId: "ta",
    content: "I'll do it",
  });
  await recordToolTurn(ws, {
    kind: "tool_call",
    sessionId: "s1", runId: "r1", turnId: "ta",
    toolName: "file_view", content: "file_view src/a.ts",
  });
  const r = buildSessionResume(ws, { recentTurns: 10 });
  assert.equal(r.rehydratedMessages.length, 7);
  // The rehydrated messages have content describing what each turn was.
  const lastMsg = r.rehydratedMessages[r.rehydratedMessages.length - 1]!;
  assert.match(lastMsg.content ?? "", /file_view/);
});

test("buildSessionResume respects maxRecentChars", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 50; i += 1) {
    await recordUserTurn(ws, {
      sessionId: "s1", runId: "r1", turnId: `t${i}`,
      content: "x".repeat(1000),
    });
  }
  const r = buildSessionResume(ws, { recentTurns: 100, maxRecentChars: 5_000 });
  // 5_000 / 1000 = 5 turns
  assert.ok(r.rehydratedMessages.length <= 6);
  assert.ok(r.stats.recentChars <= 5_500);
});

test("buildSessionResume filters by sessionId", async () => {
  const ws = await freshWorkspace();
  await recordUserTurn(ws, { sessionId: "alpha", runId: "r1", turnId: "t1", content: "alpha 1" });
  await recordUserTurn(ws, { sessionId: "beta", runId: "r1", turnId: "t1", content: "beta 1" });
  const r = buildSessionResume(ws, { sessionId: "alpha" });
  assert.equal(r.rehydratedMessages.length, 1);
  // Rehydrated messages use sha-only references, so just verify the count.
  assert.match(r.rehydratedMessages[0]!.content ?? "", /prior @/);
});

test("buildSessionResumeWithBody loads the full summary body", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 1000, postChars: 200, savedChars: 800,
    ptlDrops: 0, reattachedFiles: 0,
    body: "full body content\nwith multiple lines",
  });
  const r = await buildSessionResumeWithBody(ws);
  assert.ok(r.summary);
  assert.match(r.summary.body, /full body content/);
});
