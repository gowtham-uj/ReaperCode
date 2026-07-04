import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileViewerRegistry } from "../../../src/tools/viewer/viewer-registry.js";
import { LinterRegistry } from "../../../src/tools/viewer/linter-registry.js";
import { dispatchViewerTool } from "../../../src/tools/viewer/dispatch.js";

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-file-find-"));
  return fn(root);
}

function ctx(workspaceRoot: string) {
  return {
    workspaceRoot,
    viewerRegistry: new FileViewerRegistry(),
    linterRegistry: new LinterRegistry(),
  };
}

test("file_find handles quoted plural query against singular shard paths", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(
      path.join(workspaceRoot, "manifest.json"),
      JSON.stringify({ manifest: [{ file: "payload/shard-001.txt" }] }, null, 2),
    );

    const result = await dispatchViewerTool(
      { id: "find-1", name: "file_find", args: { path: "manifest.json", pattern: '"shards"' } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    const output = JSON.parse(result.output);
    assert.equal(output.kind, "file_find");
    assert.equal(output.matchedPattern, "shard");
    assert.match((output.window as string[]).join("\n"), /payload\/shard-001\.txt/);
  });
});

test("file_find handles case-insensitive heading queries", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, "task_prompt.md"), "# Task\n\n## Success Criteria\n\n- done\n");

    const result = await dispatchViewerTool(
      { id: "find-2", name: "file_find", args: { path: "task_prompt.md", pattern: "success criteria" } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    const output = JSON.parse(result.output);
    assert.equal(output.kind, "file_find");
    assert.equal(output.matchedPattern, "success criteria");
    assert.match((output.window as string[]).join("\n"), /Success Criteria/);
  });
});
