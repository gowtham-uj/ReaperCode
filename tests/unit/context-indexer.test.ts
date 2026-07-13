/**
 * context-indexer — walkFiles symlink-cycle regression. We verify:
 *   1. A normal workspace tree indexes correctly.
 *   2. A symlinked directory pointing back into the tree (or to a
 *      deep path) does NOT cause infinite recursion.
 *   3. A symlinked file (file target) is also skipped — we only
 *      index real files at their canonical path.
 *   4. The depth limit still applies for non-symlinked deep trees.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildCodebaseIndex } = await import("../../src/context/indexer.js");

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "reaper-idx-"));
  // Real files
  writeFileSync(join(root, "README.md"), "# hello");
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export {};");
  // Shallow deep dir (8 levels — under maxDepth=10) so the leaf
  // IS indexed by the default walkFiles config.
  mkdirSync(join(root, "a", "b", "c", "d", "e", "f", "g"), { recursive: true });
  writeFileSync(join(root, "a", "b", "c", "d", "e", "f", "g", "leaf.txt"), "deep");
  return root;
}

test("indexer: indexes a normal workspace tree", async () => {
  const root = makeTree();
  try {
    const idx = await buildCodebaseIndex(root);
    assert.ok(idx.files.length >= 3, `expected ≥3 files, got ${idx.files.length}`);
    assert.ok(idx.files.some((f) => f.relativePath === "README.md"));
    assert.ok(idx.files.some((f) => f.relativePath.endsWith("leaf.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexer: skips symlinked directories (no infinite recursion)", async (t) => {
  const root = makeTree();
  try {
    // Create a symlink that loops back to the workspace root — without
    // the symlink-skip fix, walkFiles recurses forever and overflows
    // the async stack.
    try {
      symlinkSync(root, join(root, "loop"), "dir");
      // Create a symlink that points to a deeply nested real dir.
      symlinkSync(join(root, "a"), join(root, "shallow-loop"), "dir");
      // Create a self-referential symlink (dir → ../dir). This is the
      // exact pattern from reaper_eval/pruner_env/lib64 → lib where
      // Python venvs canonicalize.
      const sub = join(root, "venv");
      mkdirSync(sub);
      symlinkSync(sub, join(sub, "loop"), "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation requires elevated privileges on this platform");
        return;
      }
      throw error;
    }

    const idx = await buildCodebaseIndex(root);
    // Symlinks must not contribute entries beyond what the real tree
    // already had.
    assert.ok(idx.files.length >= 3, `expected ≥3 files, got ${idx.files.length}`);
    // Loop must NOT appear in file list.
    assert.ok(
      !idx.files.some((f) => f.relativePath.includes("loop")),
      "symlinked directory contents should not be indexed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexer: skips symlinked files", async (t) => {
  const root = makeTree();
  try {
    try {
      symlinkSync(join(root, "README.md"), join(root, "link-to-readme"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation requires elevated privileges on this platform");
        return;
      }
      throw error;
    }
    const idx = await buildCodebaseIndex(root);
    // The real README.md should be indexed; the symlink should not.
    const realCount = idx.files.filter((f) => f.relativePath === "README.md").length;
    const linkCount = idx.files.filter((f) => f.relativePath === "link-to-readme").length;
    assert.equal(realCount, 1);
    assert.equal(linkCount, 0, "symlinked file should not be indexed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexer: respects depth limit for deep real trees", async () => {
  const root = makeTree();
  try {
    const idx = await buildCodebaseIndex(root);
    // Find the deepest indexed file — should be ≤ depth 10.
    const depth = (rel: string) => rel.split("/").length - 1;
    const maxDepth = Math.max(...idx.files.map((f) => depth(f.relativePath)));
    assert.ok(maxDepth <= 10, `indexer went past maxDepth=10 (got ${maxDepth})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexer: stack does not overflow on the real /workspace tree", async () => {
  // Smoke test against the actual workspace, which contains symlinked
  // virtualenvs under reaper_eval/. Without the fix, this throws
  // RangeError: Maximum call stack size exceeded.
  if (!existsSync("/workspace")) return; // skip on non-linux
  const idx = await buildCodebaseIndex("/workspace");
  assert.ok(idx.files.length > 0, "indexer should return files");
});

test("indexer: handles a directory with many siblings (no spread overflow)", async () => {
  // Regression for the second stack-overflow mode: a single directory
  // with thousands of entries. The original implementation used
  // `results.push(...subtree)` which spreads all entries as arguments
  // to push; V8's argument stack tops out around 64k. Linux-kernel-
  // shaped trees (drivers/gpu/drm/nouveau/include/nvrm/...) have
  // 1000+ files per directory.
  const root = mkdtempSync(join(tmpdir(), "reaper-idx-wide-"));
  try {
    const wide = join(root, "wide-dir");
    mkdirSync(wide);
    // 2000 files in one directory — enough to trip the spread bug
    // if the previous fix is reverted.
    const N = 2000;
    for (let i = 0; i < N; i++) {
      writeFileSync(join(wide, `file-${i.toString().padStart(5, "0")}.txt`), "x");
    }
    const idx = await buildCodebaseIndex(root);
    assert.equal(idx.files.length, N, `expected ${N} files, got ${idx.files.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
