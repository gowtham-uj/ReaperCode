import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadReaperConfigFromWorkspace, ReaperConfigSearchPaths } from "../../src/runtime/workspace-config.js";

test("loadReaperConfig returns {} when no config file exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-config-"));
  const config = await loadReaperConfigFromWorkspace(dir);
  assert.deepEqual(config, {});
});

test("loadReaperConfig reads .reaper/config.json from workspace root", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-config-"));
  await mkdir(path.join(dir, ".reaper"), { recursive: true });
  await writeFile(
    path.join(dir, ".reaper", "config.json"),
    JSON.stringify({ tokenBudget: { softCap: 270000 } }),
    "utf8",
  );
  const config = await loadReaperConfigFromWorkspace(dir);
  assert.deepEqual(config, { tokenBudget: { softCap: 270000 } });
});

test("ReaperConfigSearchPaths lists only .reaper/config.json", () => {
  const root = "/tmp/reaper";
  assert.deepEqual(ReaperConfigSearchPaths(root), [
    path.join(root, ".reaper", "config.json"),
  ]);
});