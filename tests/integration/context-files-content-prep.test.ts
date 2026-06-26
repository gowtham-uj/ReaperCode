import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareRuntimeContent, clearContentPrepCache } from "../../src/runtime/content-prep.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("content-prep loads context files when project is trusted", async () => {
  const workspaceRoot = await tempDir("reaper-content-prep-ctx-");
  const userHome = await tempDir("reaper-user-home-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "Project uses tabs.");
  clearContentPrepCache();
  const result = await prepareRuntimeContent(
    { workspaceRoot, userHome, prompt: "hello", maxContextTokens: 100_000 },
    { memoize: false },
  );
  assert.equal(result.contextFiles.files.length, 1);
  assert.ok(result.contextFiles.combined.includes("Project uses tabs"));
  assert.equal(result.contextFiles.diagnostics.length, 0);
});

test("content-prep omits project context files when project is not trusted", async () => {
  const workspaceRoot = await tempDir("reaper-content-prep-ctx-");
  const userHome = await tempDir("reaper-user-home-");
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".reaper/context.md"), "secret");
  // Mark workspace as requiring trust but not trusted by writing a settings file
  await mkdir(path.join(workspaceRoot, ".reaper"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".reaper/settings.json"),
    JSON.stringify({ requireProjectTrust: true }),
  );
  clearContentPrepCache();
  const result = await prepareRuntimeContent(
    { workspaceRoot, userHome, prompt: "hello", maxContextTokens: 100_000 },
    { memoize: false },
  );
  assert.equal(result.contextFiles.files.length, 0);
  assert.ok(result.contextFiles.diagnostics.some((d) => d.includes("not trusted")));
});
