import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  persistSummary,
  loadAllSummaries,
  loadSummaryBody,
} from "../../src/context/persistent-summary.js";
import {
  searchMemory,
  loadFullSummary,
} from "../../src/context/memory-search.js";

async function freshWorkspace() {
  return await mkdtemp(path.join(tmpdir(), "reaper-memtest-"));
}

test("persistSummary writes a markdown file and appends to index", async () => {
  const ws = await freshWorkspace();
  const summary = await persistSummary(ws, {
    sessionId: "s1",
    runId: "r1",
    preChars: 100000,
    postChars: 4000,
    savedChars: 96000,
    ptlDrops: 0,
    reattachedFiles: 5,
    body: "1. intent\n2. files\n3. work",
  });
  assert.ok(summary.id);
  assert.match(summary.createdAt, /\d{4}-\d{2}-\d{2}T/);
  // The .md file exists
  const dir = path.join(ws, ".reaper", "summaries");
  const files = (await readFile(path.join(dir, "index.jsonl"), "utf8")).trim().split("\n");
  assert.equal(files.length, 1);
  const idx = JSON.parse(files[0]!);
  assert.equal(idx.id, summary.id);
  assert.equal(idx.preChars, 100000);
  // The .md file has frontmatter + body
  const mdFiles = await (await import("node:fs/promises")).readdir(dir);
  const mdName = mdFiles.find((f) => f.endsWith(".md"));
  assert.ok(mdName);
  const md = await readFile(path.join(dir, mdName!), "utf8");
  assert.match(md, /^---\n/);
  assert.match(md, /pre_chars: 100000/);
  assert.match(md, /1\. intent/);
});

test("loadAllSummaries returns all persisted summaries", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 3; i += 1) {
    await persistSummary(ws, {
      sessionId: `s${i}`,
      runId: `r${i}`,
      preChars: 1000,
      postChars: 100,
      savedChars: 900,
      ptlDrops: 0,
      reattachedFiles: 0,
      body: `body ${i}`,
    });
  }
  const all = loadAllSummaries(ws);
  assert.equal(all.length, 3);
  assert.equal(all[0]!.body, "body 0");
  assert.equal(all[2]!.body, "body 2");
});

test("loadSummaryBody returns the body from the .md file", async () => {
  const ws = await freshWorkspace();
  const summary = await persistSummary(ws, {
    sessionId: "s1",
    runId: "r1",
    preChars: 1000,
    postChars: 200,
    savedChars: 800,
    ptlDrops: 0,
    reattachedFiles: 0,
    body: "alpha\nbeta\ngamma",
    query: "needle in haystack",
  });
  const body = await loadSummaryBody(ws, summary.id);
  assert.equal(body, "alpha\nbeta\ngamma");
});

test("loadSummaryBody returns null for unknown id", async () => {
  const ws = await freshWorkspace();
  const body = await loadSummaryBody(ws, "does-not-exist");
  assert.equal(body, null);
});

test("searchMemory scores by keyword overlap", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 1000, postChars: 100, savedChars: 900,
    ptlDrops: 0, reattachedFiles: 0,
    body: "Working on auth module: bcrypt, session cookies, JWT verification",
  });
  await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 1000, postChars: 100, savedChars: 900,
    ptlDrops: 0, reattachedFiles: 0,
    body: "Refactored database layer: postgres connection pool, migrations",
  });
  const authHits = await searchMemory(ws, "auth jwt session");
  assert.ok(authHits.length >= 1, "expected at least one auth hit");
  assert.match(authHits[0]!.bodyPreview, /auth/);
  assert.ok(authHits[0]!.score > 0);
  const dbHits = await searchMemory(ws, "postgres migration");
  assert.ok(dbHits.length >= 1);
  assert.match(dbHits[0]!.bodyPreview, /postgres/);
});

test("searchMemory with empty query returns most recent", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 4; i += 1) {
    await persistSummary(ws, {
      sessionId: "s1", runId: "r1",
      preChars: 1000, postChars: 100, savedChars: 900,
      ptlDrops: 0, reattachedFiles: 0,
      body: `body ${i}`,
    });
  }
  const recent = await searchMemory(ws, "");
  assert.equal(recent.length, 4);
  assert.match(recent[3]!.bodyPreview, /body 3/);
});

test("searchMemory honors maxHits", async () => {
  const ws = await freshWorkspace();
  for (let i = 0; i < 10; i += 1) {
    await persistSummary(ws, {
      sessionId: "s1", runId: "r1",
      preChars: 1000, postChars: 100, savedChars: 900,
      ptlDrops: 0, reattachedFiles: 0,
      body: `auth ${i}`,
    });
  }
  const top3 = await searchMemory(ws, "auth", { maxHits: 3 });
  assert.equal(top3.length, 3);
});

test("searchMemory filters by sessionId and since", async () => {
  const ws = await freshWorkspace();
  await persistSummary(ws, {
    sessionId: "alpha", runId: "r1",
    preChars: 1000, postChars: 100, savedChars: 900,
    ptlDrops: 0, reattachedFiles: 0,
    body: "alpha event",
  });
  await persistSummary(ws, {
    sessionId: "beta", runId: "r1",
    preChars: 1000, postChars: 100, savedChars: 900,
    ptlDrops: 0, reattachedFiles: 0,
    body: "beta event",
  });
  const alphaOnly = await searchMemory(ws, "event", { sessionId: "alpha" });
  assert.equal(alphaOnly.length, 1);
  assert.match(alphaOnly[0]!.bodyPreview, /alpha/);
});

test("loadFullSummary returns body and metadata", async () => {
  const ws = await freshWorkspace();
  const s = await persistSummary(ws, {
    sessionId: "s1", runId: "r1",
    preChars: 1000, postChars: 200, savedChars: 800,
    ptlDrops: 0, reattachedFiles: 0,
    body: "alpha\nbeta",
  });
  const full = await loadFullSummary(ws, s.id);
  assert.ok(full);
  assert.equal(full!.body, "alpha\nbeta");
  assert.equal(full!.preChars, 1000);
});

test("persistSummary redacts secrets from every durable summary field", async () => {
  const ws = await freshWorkspace();
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const summary = await persistSummary(ws, {
    sessionId: "s1",
    runId: "r1",
    preChars: 1000,
    postChars: 200,
    savedChars: 800,
    ptlDrops: 0,
    reattachedFiles: 0,
    body: `Body leaked ${secret}`,
    query: `Query leaked ${secret}`,
    epoch: 1,
    checkpoint: {
      schemaVersion: 1,
      epoch: 1,
      originalTask: `Task leaked ${secret}`,
      currentTask: "continue safely",
      goldenFacts: [`Fact leaked ${secret}`],
      completedSteps: [],
      decisions: [],
      failures: [],
      files: [],
      nextAction: "verify persistence",
      summarySha256: "not-a-real-hash",
    },
  });

  const dir = path.join(ws, ".reaper", "summaries");
  const index = await readFile(path.join(dir, "index.jsonl"), "utf8");
  const mdFiles = await (await import("node:fs/promises")).readdir(dir);
  const mdName = mdFiles.find((file) => file.endsWith(".md"));
  assert.ok(mdName);
  const markdown = await readFile(path.join(dir, mdName), "utf8");
  const returned = JSON.stringify(summary);

  for (const durableValue of [index, markdown, returned]) {
    assert.doesNotMatch(durableValue, new RegExp(secret));
    assert.match(durableValue, /\[REDACTED:github-token\]/);
  }
});
