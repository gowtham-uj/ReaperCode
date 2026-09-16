import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePatch, executeApplyPatch } from "../../src/tools/apply-patch.js";

/**
 * Phase 3 smoke test: apply_patch_edit modifies a file.
 */
test("Phase 3: apply_patch modifies an existing file", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-patch-"));
  try {
    // Setup: create a file with TODO
    await writeFile(path.join(workspaceRoot, "README.md"), "# Project\n\nTODO: implement features\n", "utf8");

    const patch = `--- a/README.md
+++ b/README.md
@@ -1,3 +1,3 @@
 # Project
 
-TODO: implement features
+DONE: features implemented
`;

    const result = await executeApplyPatch(patch, workspaceRoot, false);
    assert.equal(result.applied, true);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.path, "README.md");
    assert.equal(result.files[0]?.action, "modified");
    assert.equal(result.files[0]?.additions, 1);
    assert.equal(result.files[0]?.removals, 1);

    const content = await readFile(path.join(workspaceRoot, "README.md"), "utf8");
    assert.match(content, /DONE: features implemented/);
    assert.doesNotMatch(content, /TODO/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Phase 3: apply_patch creates a new file.
 */
test("Phase 3: apply_patch creates a new file from /dev/null", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-patch-new-"));
  try {
    const patch = `--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,2 @@
+export const greeting = "hello";
+export const version = "1.0";
`;

    const result = await executeApplyPatch(patch, workspaceRoot, false);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.path, "new-file.ts");
    assert.equal(result.files[0]?.action, "created");
    assert.equal(result.files[0]?.additions, 2);

    const content = await readFile(path.join(workspaceRoot, "new-file.ts"), "utf8");
    assert.match(content, /export const greeting/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Phase 3: apply_patch modifies multiple files in one call.
 */
test("Phase 3: apply_patch modifies multiple files", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-patch-multi-"));
  try {
    await writeFile(path.join(workspaceRoot, "file1.txt"), "TODO: fix this\n", "utf8");
    await writeFile(path.join(workspaceRoot, "file2.txt"), "TODO: fix that\n", "utf8");

    const patch = `--- a/file1.txt
+++ b/file1.txt
@@ -1 +1 @@
-TODO: fix this
+DONE: fixed this
--- a/file2.txt
+++ b/file2.txt
@@ -1 +1 @@
-TODO: fix that
+DONE: fixed that
`;

    const result = await executeApplyPatch(patch, workspaceRoot, false);
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0]?.action, "modified");
    assert.equal(result.files[1]?.action, "modified");

    const content1 = await readFile(path.join(workspaceRoot, "file1.txt"), "utf8");
    const content2 = await readFile(path.join(workspaceRoot, "file2.txt"), "utf8");
    assert.match(content1, /DONE: fixed this/);
    assert.match(content2, /DONE: fixed that/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Phase 3: dry_run doesn't write to disk.
 */
test("Phase 3: apply_patch dry_run does not write", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-patch-dry-"));
  try {
    await writeFile(path.join(workspaceRoot, "test.txt"), "original\n", "utf8");

    const patch = `--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-original
+modified
`;

    const result = await executeApplyPatch(patch, workspaceRoot, true);
    assert.equal(result.applied, false);
    assert.equal(result.dry_run, true);

    // File should be unchanged
    const content = await readFile(path.join(workspaceRoot, "test.txt"), "utf8");
    assert.equal(content, "original\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Phase 3: parsePatch correctly parses a unified diff.
 */
test("Phase 3: parsePatch parses a simple diff", () => {
  const patch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 3;
`;
  const parsed = parsePatch(patch);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.oldPath, "test.ts");
  assert.equal(parsed[0]?.newPath, "test.ts");
  assert.equal(parsed[0]?.isNew, false);
  assert.equal(parsed[0]?.hunks.length, 1);
  assert.equal(parsed[0]?.hunks[0]?.oldStart, 1);
  assert.equal(parsed[0]?.hunks[0]?.lines.filter((l) => l.type === "remove").length, 1);
  assert.equal(parsed[0]?.hunks[0]?.lines.filter((l) => l.type === "add").length, 1);
  assert.equal(parsed[0]?.hunks[0]?.lines.filter((l) => l.type === "context").length, 2);
});

/**
 * A patch that ends in a trailing blank line must apply, not be rejected.
 *
 * This is the shape a model produces when it terminates its patch with a
 * newline after the final content line, which is the ordinary way to end a
 * text block. The split left a synthetic empty context line at the end of the
 * last hunk, that line counted toward the hunk's old/new totals, and validation
 * failed with "consumes N new line(s); malformed hunk" — for a patch that was
 * perfectly well formed. The same patch without the trailing blank applied
 * cleanly, so the rejection was about the terminator rather than the content.
 */
test("parsePatch accepts a patch whose text ends in a trailing blank line", () => {
  const body = `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,3 @@
 alpha
 beta
+gamma`;
  for (const [name, patch] of [["no trailing newline", body], ["one trailing newline", `${body}\n`], ["trailing blank line", `${body}\n\n`]] as const) {
    const parsed = parsePatch(patch);
    assert.equal(parsed.length, 1, name);
    assert.equal(parsed[0]?.hunks.length, 1, name);
    assert.equal(parsed[0]?.hunks[0]?.lines.length, 3, `${name}: the blank line must not become a context line`);
    assert.equal(parsed[0]?.hunks[0]?.lines.filter((l) => l.type === "add").length, 1, name);
  }
});

/**
 * A blank line that is genuinely part of the hunk's content stays.
 *
 * The fix drops trailing empty context lines only while a hunk is over its
 * declared count, so an interior blank line — which the header accounts for —
 * is untouched. Without that guard the fix would corrupt any patch over a file
 * that contains a blank line.
 */
test("parsePatch keeps an interior blank context line", () => {
  const patch = `--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@
 alpha

-beta
+BETA
 delta
`;
  const parsed = parsePatch(patch);
  const lines = parsed[0]?.hunks[0]?.lines ?? [];
  // alpha, the blank context line, -beta, +BETA, delta.
  assert.equal(lines.length, 5);
  assert.equal(lines[1]?.type, "context");
  assert.equal(lines[1]?.content, "");
});
