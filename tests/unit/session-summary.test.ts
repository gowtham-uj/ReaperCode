import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendBullet,
  createEmptySessionSummary,
  loadSessionSummary,
  normalizeSessionSummary,
  renderSessionSummaryForCockpit,
  saveSessionSummary,
  summarizeSessionForCompaction,
} from "../../src/context/session-summary.js";

test("createEmptySessionSummary has stable shape with empty sections", () => {
  const empty = createEmptySessionSummary();
  for (const key of Object.keys(empty) as Array<keyof typeof empty>) {
    assert.deepEqual(empty[key].bullets, [], `expected ${key} to start empty`);
  }
});

test("appendBullet dedupes consecutive duplicates and clips to max", () => {
  let summary = createEmptySessionSummary();
  for (let i = 0; i < 25; i += 1) {
    summary = appendBullet(summary, "intent", `note ${i}`);
  }
  assert.ok(summary.intent.bullets.length <= 20, "max bullets should be enforced");
  // Last bullet is the truncation marker.
  const last = summary.intent.bullets.at(-1) ?? "";
  assert.match(last, /\(\+\d+ earlier\)/);
});

test("appendBullet does not duplicate recent bullets", () => {
  let summary = createEmptySessionSummary();
  summary = appendBullet(summary, "intent", "wire content prep");
  summary = appendBullet(summary, "intent", "wire content prep"); // duplicate
  assert.equal(summary.intent.bullets.length, 1);
});

test("summarizeSessionForCompaction extracts intent, files, failures, verification", () => {
  const summary = summarizeSessionForCompaction({
    prompt: "wire content prep",
    toolResults: [
      { name: "read_file", ok: true, args: { path: "src/index.ts" } },
      { name: "bash", ok: true, args: { cmd: "npm test" }, output: { exitCode: 0 } },
      { name: "replace_in_file", ok: true, args: { path: "src/runtime/engine.ts" } },
      { name: "read_file", ok: true, args: { path: "src/runtime/engine.ts" } },
      { name: "bash", ok: false, args: { cmd: "npm test" }, error: { message: "1 failing" } },
    ],
  });
  assert.equal(summary.intent.bullets[0], "wire content prep");
  assert.ok(summary.filesTouched.bullets.includes("src/index.ts"));
  assert.ok(summary.filesTouched.bullets.includes("src/runtime/engine.ts"));
  // Latest verification is the failure.
  assert.match(summary.verification.bullets[0] ?? "", /FAIL npm test/);
  // First failed attempt is the npm test failure.
  const firstFailure = summary.failedAttempts.bullets[0] ?? "";
  assert.match(firstFailure, /bash/);
  assert.match(firstFailure, /1 failing/);
});

test("renderSessionSummaryForCockpit renders a markdown block and skips empty sections", () => {
  const summary = createEmptySessionSummary();
  const updated = appendBullet(summary, "intent", "fix the bug");
  const rendered = renderSessionSummaryForCockpit(updated);
  assert.match(rendered, /### Intent/);
  assert.match(rendered, /- fix the bug/);
  assert.doesNotMatch(rendered, /### Files/);
});

test("saveSessionSummary round-trips through loadSessionSummary", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reaper-session-summary-"));
  try {
    let summary = createEmptySessionSummary();
    summary = appendBullet(summary, "intent", "ship it");
    await saveSessionSummary({ workspaceRoot: dir, runId: "r1" }, summary);
    const loaded = await loadSessionSummary({ workspaceRoot: dir, runId: "r1" });
    assert.ok(loaded);
    assert.equal(loaded?.intent.bullets[0], "ship it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSessionSummary sanitizes malformed input", () => {
  const norm = normalizeSessionSummary({ intent: { bullets: ["ok", ""], updatedAt: 1 } });
  assert.deepEqual(norm.intent.bullets, ["ok"]);
});
