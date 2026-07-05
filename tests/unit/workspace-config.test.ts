import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { mergeWorkspaceConfig } from "../../src/runtime/workspace-config.js";

test("mergeWorkspaceConfig returns the explicit config when no workspace file exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-merge-"));
  const merged = await mergeWorkspaceConfig({ tokenBudget: { softCap: 90000 } }, dir);
  assert.deepEqual(merged, { tokenBudget: { softCap: 90000 } });
});

test("mergeWorkspaceConfig reads .reaper/config.json and layers it under explicit config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-merge-"));
  await mkdir(path.join(dir, ".reaper"), { recursive: true });
  await writeFile(
    path.join(dir, ".reaper", "config.json"),
    JSON.stringify({ tokenBudget: { softCap: 270000 } }),
    "utf8",
  );
  const merged = await mergeWorkspaceConfig({ models: { default_model: { id: "x" } } }, dir);
  assert.equal((merged as { models: unknown }).models && typeof (merged as { models: unknown }).models === "object", true);
  assert.equal((merged as { tokenBudget: { softCap: number } }).tokenBudget.softCap, 270000);
});

test("mergeWorkspaceConfig falls back to disk when explicit config is not an object", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-merge-"));
  await mkdir(path.join(dir, ".reaper"), { recursive: true });
  await writeFile(
    path.join(dir, ".reaper", "config.json"),
    JSON.stringify({ tokenBudget: { softCap: 270000 } }),
    "utf8",
  );
  const merged = await mergeWorkspaceConfig(null, dir);
  assert.deepEqual(merged, { tokenBudget: { softCap: 270000 } });
});