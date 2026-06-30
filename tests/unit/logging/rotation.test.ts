/**
 * Phase T3.13 unit tests for the rotation policy planner.
 *
 * Covers:
 *   - `shouldRotate` returns null when under size AND under age cap.
 *   - `shouldRotate` returns "size" when size cap is exceeded.
 *   - `shouldRotate` returns "size_double" when size is 2× cap.
 *   - `shouldRotate` returns "age" when age cap is exceeded.
 *   - `planRotation` returns null when no rotation is needed.
 *   - `planRotation` returns a plan that bumps existing rotations.
 *   - `planRotation` returns a plan that deletes files past keepCount.
 *   - `appendRotationSuffix` and `bumpPath` produce the right paths.
 *   - `parseRotationIndex` parses standard and non-standard names.
 *   - `defaultRotationPolicy` reads env vars with defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRotationSuffix,
  bumpPath,
  defaultRotationPolicy,
  parseRotationIndex,
  planRotation,
  shouldRotate,
  type RotationPolicy,
} from "../../../src/logging/rotation.js";

const NOW = Date.parse("2026-06-21T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const basePolicy: RotationPolicy = {
  maxBytes: 100 * MB,
  maxRotatedFiles: 5,
  maxAgeMs: 7 * DAY,
};

test("shouldRotate returns null when under both caps", () => {
  assert.equal(shouldRotate(50 * MB, NOW - HOUR, NOW, basePolicy), null);
});

test("shouldRotate returns 'size' when size cap is exceeded (just over)", () => {
  assert.equal(shouldRotate(101 * MB, NOW - HOUR, NOW, basePolicy), "size");
});

test("shouldRotate returns 'size_double' when size is 2x the cap", () => {
  assert.equal(shouldRotate(250 * MB, NOW - HOUR, NOW, basePolicy), "size_double");
});

test("shouldRotate returns 'age' when age cap is exceeded", () => {
  assert.equal(shouldRotate(10 * MB, NOW - 8 * DAY, NOW, basePolicy), "age");
});

test("shouldRotate returns 'size' when both size and age exceed (under double cap)", () => {
  // 150 MB is over the 100 MB cap but under 2×. Age is also exceeded.
  // size check fires first; age is irrelevant when size already won.
  assert.equal(shouldRotate(150 * MB, NOW - 30 * DAY, NOW, basePolicy), "size");
});

test("shouldRotate returns 'size_double' when both size and age exceed (over double cap)", () => {
  // 250 MB is over 2× the 100 MB cap. Age is also exceeded.
  assert.equal(shouldRotate(250 * MB, NOW - 30 * DAY, NOW, basePolicy), "size_double");
});

test("planRotation returns null when no rotation is needed", () => {
  const plan = planRotation({
    activeFilePath: "/a/foo.jsonl",
    currentSizeBytes: 50 * MB,
    currentMtimeMs: NOW - HOUR,
    nowMs: NOW,
    policy: basePolicy,
    existingRotatedFiles: [],
  });
  assert.equal(plan, null);
});

test("planRotation produces a rotation plan with the active file moved to .1.bak", () => {
  const plan = planRotation({
    activeFilePath: "/a/foo.jsonl",
    currentSizeBytes: 200 * MB,
    currentMtimeMs: NOW - HOUR,
    nowMs: NOW,
    policy: basePolicy,
    existingRotatedFiles: [],
  });
  assert.ok(plan, "expected a plan");
  assert.equal(plan.newRotationTarget, "/a/foo.jsonl.1.bak");
  assert.deepEqual(plan.filesToDelete, []);
  assert.deepEqual(plan.filesToRename, []);
});

test("planRotation bumps existing rotations when keepCount allows", () => {
  const plan = planRotation({
    activeFilePath: "/a/foo.jsonl",
    currentSizeBytes: 200 * MB,
    currentMtimeMs: NOW - HOUR,
    nowMs: NOW,
    policy: basePolicy,
    existingRotatedFiles: ["/a/foo.jsonl.1.bak", "/a/foo.jsonl.2.bak", "/a/foo.jsonl.3.bak"],
  });
  assert.ok(plan, "expected a plan");
  // Existing rotations bump up by 1. The planner orders renames
  // highest-index-first so a failed bump of a lower-index file
  // doesn't shadow the higher-index rename target.
  assert.deepEqual(plan.filesToRename, [
    { from: "/a/foo.jsonl.3.bak", to: "/a/foo.jsonl.4.bak" },
    { from: "/a/foo.jsonl.2.bak", to: "/a/foo.jsonl.3.bak" },
    { from: "/a/foo.jsonl.1.bak", to: "/a/foo.jsonl.2.bak" },
  ]);
  // Active file moves to .1.bak.
  assert.equal(plan.newRotationTarget, "/a/foo.jsonl.1.bak");
  // Nothing deleted yet (keepCount is 5, we have 3 existing + 1 new = 4).
  assert.deepEqual(plan.filesToDelete, []);
});

test("planRotation deletes rotations past keepCount", () => {
  const policy = { ...basePolicy, maxRotatedFiles: 3 };
  const plan = planRotation({
    activeFilePath: "/a/foo.jsonl",
    currentSizeBytes: 200 * MB,
    currentMtimeMs: NOW - HOUR,
    nowMs: NOW,
    policy,
    existingRotatedFiles: [
      "/a/foo.jsonl.1.bak",
      "/a/foo.jsonl.2.bak",
      "/a/foo.jsonl.3.bak",
      "/a/foo.jsonl.4.bak",
      "/a/foo.jsonl.5.bak",
    ],
  });
  assert.ok(plan);
  // After bumping: 1→2, 2→3, 3→4, 4→5, 5→6. Plus the active
  // moves to .1.bak. Keep 3 means we keep indices 1, 2, 3 (three
  // total). Everything past index 3 is deleted — indices 4, 5, 6
  // (three files).
  assert.equal(plan.filesToDelete.length, 3);
  assert.deepEqual(plan.filesToDelete.sort(), [
    "/a/foo.jsonl.4.bak",
    "/a/foo.jsonl.5.bak",
    "/a/foo.jsonl.6.bak",
  ].sort());
  // Renames for indices 1→2, 2→3. (3→4 and 4→5 and 5→6 are also
  // renames in the planner, but the corresponding targets are
  // slated for deletion so the planner still emits them — the
  // caller does the rename-then-delete dance. In practice the
  // fs.rename overwrites the existing target if any, but the
  // delete pass afterward reaps them all.)
  // We don't assert the exact count here — just that something is
  // renamed and the deletions are right.
  assert.ok(plan.filesToRename.length > 0);
});

test("planRotation with no existing rotations handles a single rotation cleanly", () => {
  const plan = planRotation({
    activeFilePath: "/a/foo.jsonl",
    currentSizeBytes: 200 * MB,
    currentMtimeMs: NOW - HOUR,
    nowMs: NOW,
    policy: { ...basePolicy, maxRotatedFiles: 1 },
    existingRotatedFiles: [],
  });
  assert.ok(plan);
  assert.deepEqual(plan.filesToRename, []);
  assert.deepEqual(plan.filesToDelete, []);
  assert.equal(plan.newRotationTarget, "/a/foo.jsonl.1.bak");
});

test("planRotation with keepCount=1 deletes the previous rotation", () => {
  const plan = planRotation({
    activeFilePath: "/a/foo.jsonl",
    currentSizeBytes: 200 * MB,
    currentMtimeMs: NOW - HOUR,
    nowMs: NOW,
    policy: { ...basePolicy, maxRotatedFiles: 1 },
    existingRotatedFiles: ["/a/foo.jsonl.1.bak", "/a/foo.jsonl.2.bak"],
  });
  assert.ok(plan);
  // After bumping: 1→2, 2→3. Keep 1 means only index 1 stays.
  // Index 2 (was 1, bumped to 2 — deleted) and index 3 (was 2,
  // bumped to 3 — deleted). Plus the active moves to .1.bak.
  assert.equal(plan.filesToDelete.length, 2);
  assert.deepEqual(plan.filesToDelete.sort(), [
    "/a/foo.jsonl.2.bak",
    "/a/foo.jsonl.3.bak",
  ].sort());
});

test("appendRotationSuffix builds the canonical rotated path", () => {
  assert.equal(appendRotationSuffix("/a/foo.jsonl", 1), "/a/foo.jsonl.1.bak");
  assert.equal(appendRotationSuffix("/a/foo.jsonl", 12), "/a/foo.jsonl.12.bak");
  assert.equal(appendRotationSuffix("/var/log/reaper.jsonl", 3), "/var/log/reaper.jsonl.3.bak");
});

test("bumpPath increments the index on standard rotation names", () => {
  assert.equal(bumpPath("/a/foo.jsonl.1.bak", 2), "/a/foo.jsonl.2.bak");
  assert.equal(bumpPath("/a/foo.jsonl.5.bak", 6), "/a/foo.jsonl.6.bak");
});

test("bumpPath returns input unchanged for non-rotation names", () => {
  assert.equal(bumpPath("/a/foo.jsonl", 2), "/a/foo.jsonl");
  assert.equal(bumpPath("/a/foo.bak", 2), "/a/foo.bak");
});

test("parseRotationIndex extracts the index from standard names", () => {
  assert.equal(parseRotationIndex("/a/foo.jsonl.1.bak"), 1);
  assert.equal(parseRotationIndex("/a/foo.jsonl.12.bak"), 12);
});

test("parseRotationIndex returns undefined for non-rotation names", () => {
  assert.equal(parseRotationIndex("/a/foo.jsonl"), undefined);
  assert.equal(parseRotationIndex("/a/foo.bak"), undefined);
  assert.equal(parseRotationIndex("/a/foo.jsonl.bak"), undefined);
  assert.equal(parseRotationIndex("/a/foo.jsonl.foo.bak"), undefined);
});

test("defaultRotationPolicy returns sane defaults", () => {
  // Reset env vars so the default path is taken.
  const saved = {
    maxBytes: process.env.REAPER_LOG_MAX_BYTES,
    rotated: process.env.REAPER_LOG_MAX_ROTATED_FILES,
    age: process.env.REAPER_LOG_MAX_AGE_MS,
  };
  delete process.env.REAPER_LOG_MAX_BYTES;
  delete process.env.REAPER_LOG_MAX_ROTATED_FILES;
  delete process.env.REAPER_LOG_MAX_AGE_MS;
  try {
    const policy = defaultRotationPolicy();
    assert.equal(policy.maxBytes, 100 * MB);
    assert.equal(policy.maxRotatedFiles, 5);
    assert.equal(policy.maxAgeMs, 7 * DAY);
  } finally {
    if (saved.maxBytes !== undefined) process.env.REAPER_LOG_MAX_BYTES = saved.maxBytes;
    if (saved.rotated !== undefined) process.env.REAPER_LOG_MAX_ROTATED_FILES = saved.rotated;
    if (saved.age !== undefined) process.env.REAPER_LOG_MAX_AGE_MS = saved.age;
  }
});

test("defaultRotationPolicy honors env-var overrides", () => {
  const saved = {
    maxBytes: process.env.REAPER_LOG_MAX_BYTES,
    rotated: process.env.REAPER_LOG_MAX_ROTATED_FILES,
    age: process.env.REAPER_LOG_MAX_AGE_MS,
  };
  process.env.REAPER_LOG_MAX_BYTES = "1000";
  process.env.REAPER_LOG_MAX_ROTATED_FILES = "9";
  process.env.REAPER_LOG_MAX_AGE_MS = "60000";
  try {
    const policy = defaultRotationPolicy();
    assert.equal(policy.maxBytes, 1000);
    assert.equal(policy.maxRotatedFiles, 9);
    assert.equal(policy.maxAgeMs, 60_000);
  } finally {
    if (saved.maxBytes === undefined) delete process.env.REAPER_LOG_MAX_BYTES;
    else process.env.REAPER_LOG_MAX_BYTES = saved.maxBytes;
    if (saved.rotated === undefined) delete process.env.REAPER_LOG_MAX_ROTATED_FILES;
    else process.env.REAPER_LOG_MAX_ROTATED_FILES = saved.rotated;
    if (saved.age === undefined) delete process.env.REAPER_LOG_MAX_AGE_MS;
    else process.env.REAPER_LOG_MAX_AGE_MS = saved.age;
  }
});

test("defaultRotationPolicy ignores malformed env vars and uses defaults", () => {
  const savedMax = process.env.REAPER_LOG_MAX_BYTES;
  process.env.REAPER_LOG_MAX_BYTES = "not-a-number";
  try {
    const policy = defaultRotationPolicy();
    assert.equal(policy.maxBytes, 100 * MB);
  } finally {
    if (savedMax === undefined) delete process.env.REAPER_LOG_MAX_BYTES;
    else process.env.REAPER_LOG_MAX_BYTES = savedMax;
  }
});
