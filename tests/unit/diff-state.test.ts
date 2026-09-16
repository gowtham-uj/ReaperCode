import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { getGitDiffState, getGitStatusState, summarizeGitDiffState } from "../../src/runtime/diff-state.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("git status state reports clean and dirty workspaces", async () => {
  const workspaceRoot = await createTempWorkspace();

  const clean = await getGitStatusState(workspaceRoot);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.entries, []);

  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 42;\n", "utf8");
  const dirty = await getGitStatusState(workspaceRoot);

  assert.equal(dirty.clean, false);
  assert.deepEqual(dirty.entries, [{ code: " M", path: "src/app.ts" }]);
});

test("git diff state summarizes a controlled mutation", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 42;\n", "utf8");

  const diff = await getGitDiffState(workspaceRoot);

  assert.equal(diff.status.clean, false);
  assert.match(diff.diffStat, /src\/app.ts/);
  assert.match(diff.diff, /-export const answer = 41;/);
  assert.match(diff.diff, /\+export const answer = 42;/);
  assert.equal(diff.truncated, false);
  assert.match(summarizeGitDiffState(diff), /1 changed file/);
});

/**
 * Untracked files are counted separately from changes that have a diff.
 *
 * The reported failure: a workspace of eight brand-new files returned
 * `diff: ""` and `diffStat: ""` under a summary reading "8 changed files". `git
 * diff` never shows untracked files — they have no committed version to compare
 * against — so the header claimed eight changes and the body showed none, which
 * reads as a diff that was elided rather than one that does not exist. The
 * summary now names both numbers, so "8 untracked files (no diff until added)"
 * says what the empty diff below it means.
 */
test("the git diff summary separates untracked files from tracked changes", async () => {
  const { mkdir } = await import("node:fs/promises");
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "newdir"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(path.join(workspaceRoot, "newdir", name), "brand new\n", "utf8");
  }

  const diff = await getGitDiffState(workspaceRoot);
  assert.equal(diff.diff.trim(), "", "untracked files produce no diff");
  const summary = summarizeGitDiffState(diff);
  assert.match(summary, /3 untracked files/);
  assert.doesNotMatch(summary, /3 changed files/, "untracked files must not be counted as changed files");
  assert.match(summary, /no diff until added/);
});

test("the git diff summary still counts a tracked change", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 42;\n", "utf8");
  const summary = summarizeGitDiffState(await getGitDiffState(workspaceRoot));
  assert.match(summary, /1 changed file/);
});
