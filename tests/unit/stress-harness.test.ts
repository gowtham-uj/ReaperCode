import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  setupStressTask,
  snapshotOriginalTests,
  verifyWithOriginalTests,
  TASKS,
} from "../../scripts/stress-reaper.js";

async function tempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("setupStressTask writes buggy implementation and failing test", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const targetRoot = await mkdtemp(path.join(tmpdir(), "reaper-stress-setup-"));
  const task = TASKS[0]!;
  await setupStressTask(task, targetRoot);

  const impl = await readFile(path.join(targetRoot, task.implFile), "utf8");
  assert.match(impl, /isPalindrome/);

  const testContent = await readFile(path.join(targetRoot, task.testFile), "utf8");
  assert.match(testContent, /isPalindrome/);

  const pkg = await readFile(path.join(targetRoot, "package.json"), "utf8");
  assert.match(pkg, /"test"/);

  await stat(path.join(targetRoot, ".git"));
});

test("snapshotOriginalTests preserves original test file", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const targetRoot = await mkdtemp(path.join(tmpdir(), "reaper-stress-snap-"));
  const snapshotDir = path.join(targetRoot, ".stress-snapshot");
  const task = TASKS[0]!;
  await setupStressTask(task, targetRoot);
  await snapshotOriginalTests(task, targetRoot, snapshotDir);
  const original = await readFile(path.join(targetRoot, task.testFile), "utf8");
  const snap = await readFile(path.join(snapshotDir, path.basename(task.testFile)), "utf8");
  assert.equal(original, snap);
});

test("verifyWithOriginalTests passes when implementation matches original expectations", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const targetRoot = await mkdtemp(path.join(tmpdir(), "reaper-stress-verify-"));
  const snapshotDir = path.join(targetRoot, ".stress-snapshot");
  const task = TASKS[0]!;
  await setupStressTask(task, targetRoot);
  await snapshotOriginalTests(task, targetRoot, snapshotDir);
  // apply the fix to satisfy the original test
  const fixed = task.buggyImpl.replace(
    /return str === str\\.split\\(""\\)\\.reverse\\(\\)\\.join\\(""\\);/,
    "const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, ''); return cleaned === cleaned.split('').reverse().join('');",
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(targetRoot, task.implFile), fixed, "utf8");
  const ok = await verifyWithOriginalTests(task, targetRoot, snapshotDir);
  assert.equal(ok, true);
});
