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
