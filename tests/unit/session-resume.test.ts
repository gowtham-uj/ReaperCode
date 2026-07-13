import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSessionResume, buildSessionResumeWithBody } from "../../src/context/session-resume.js";
import { persistSummary } from "../../src/context/persistent-summary.js";

async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-resumetest-"));
}

test("buildSessionResume with no prior data returns an empty re-anchor", async () => {
  const ws = await freshWorkspace();
  const r = buildSessionResume(ws);
  assert.equal(r.reAnchor, "");
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

test("buildSessionResume never carries raw turns — journal owns raw rehydration", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 1000, postChars: 200, savedChars: 800,
    ptlDrops: 0, reattachedFiles: 0,
    body: "some summary",
  });
  const r = buildSessionResume(ws);
  assert.equal(r.rehydratedMessages.length, 0);
  assert.equal(r.stats.recentTurns, 0);
});

test("buildSessionResume filters summaries by sessionId", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "alpha", runId: "r1",
    preChars: 100, postChars: 50, savedChars: 50,
    ptlDrops: 0, reattachedFiles: 0,
    body: "alpha work",
  });
  await persistSummary(ws, {
    sessionId: "beta", runId: "r2",
    preChars: 100, postChars: 50, savedChars: 50,
    ptlDrops: 0, reattachedFiles: 0,
    body: "beta work",
  });
  const r = buildSessionResume(ws, { sessionId: "alpha" });
  assert.ok(r.summary);
  assert.match(r.summary.body, /alpha work/);
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
