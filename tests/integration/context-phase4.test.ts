import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getCachedIndex } from "../../src/context/cache.js";
import { compactToolHistory, renderToolResultForModel } from "../../src/context/history-compaction.js";
import { buildCodebaseIndex } from "../../src/context/indexer.js";
import { resolveMentions } from "../../src/context/mentions.js";
import { prepareContext } from "../../src/context/pruner.js";
import { prepareRuntimeContent } from "../../src/runtime/content-prep.js";
import { RuntimeEngine } from "../../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../fixtures/phase0.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

async function createMediumWorkspace() {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "src", "features"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });

  for (let index = 0; index < 12; index += 1) {
    await writeFile(
      path.join(workspaceRoot, "src", "features", `feature-${index}.ts`),
      `export const feature_${index} = "feature-${index}";\nexport function runFeature${index}() { return feature_${index}; }\n`,
      "utf8",
    );
  }

  await writeFile(path.join(workspaceRoot, "docs", "architecture.md"), "# Architecture\nThis file explains feature modules.\n", "utf8");
  return workspaceRoot;
}

test("content prep resolves @file mentions into pinned context and keeps always-include files", async () => {
  const workspaceRoot = await createMediumWorkspace();
  const result = await prepareRuntimeContent({
    workspaceRoot,
    prompt: "Inspect @src/app.ts and @README.md before changing anything.",
    maxContextTokens: 4000,
  });

  const chunkPaths = result.preparedContext.chunks.map((chunk) => chunk.path);
  assert.ok(chunkPaths.includes("src/app.ts"));
  assert.ok(chunkPaths.includes("README.md"));
  assert.ok(chunkPaths.includes("package.json"));
  assert.deepEqual(result.mentions.fileMentions, ["src/app.ts", "README.md"]);
});

test("prepared context respects token budgets on a medium workspace", async () => {
  const workspaceRoot = await createMediumWorkspace();
  const result = await prepareRuntimeContent({
    workspaceRoot,
    prompt: "Review all feature files and architecture docs for feature behavior.",
    maxContextTokens: 120,
  });

  assert.ok(result.preparedContext.usedTokens <= 120);
  assert.ok(result.preparedContext.droppedPaths.length > 0);
});

test("deterministic truncation yields stable chunk ordering for the same workspace and prompt", async () => {
  const workspaceRoot = await createMediumWorkspace();
  const index = await buildCodebaseIndex(workspaceRoot);
  const mentions = resolveMentions("Review @src/app.ts and feature modules");

  const first = await prepareContext({
    index,
    prompt: "Review @src/app.ts and feature modules",
    mentions,
    maxTokens: 140,
  });
  const second = await prepareContext({
    index,
    prompt: "Review @src/app.ts and feature modules",
    mentions,
    maxTokens: 140,
  });

  assert.deepEqual(
    first.chunks.map((chunk) => chunk.path),
    second.chunks.map((chunk) => chunk.path),
  );
});

test("history compaction preserves recent entries and pins latest verification failure", async () => {
  const compacted = compactToolHistory({
    maxEntries: 2,
    latestVerificationFailure: "Expected 42 but got 41",
    toolResults: [
      { toolCallId: "1", name: "read_file", ok: true, durationMs: 10 },
      { toolCallId: "2", name: "replace_in_file", ok: true, durationMs: 20 },
      { toolCallId: "3", name: "bash", ok: false, durationMs: 30, error: { code: "tool_error", message: "boom" } },
    ],
  });

  assert.equal(compacted.compacted.length, 2);
  assert.equal(compacted.retained.length, 2);
  assert.equal(compacted.pinnedVerificationFailure, "Expected 42 but got 41");
});

test("tool result rendering truncates large outputs by preserving head and tail", async () => {
  const rendered = renderToolResultForModel({
    toolCallId: "long-output",
    name: "bash",
    ok: true,
    durationMs: 10,
    output: { stdout: `${"a".repeat(7000)}TAIL_ERROR` },
  });

  assert.equal(rendered.outputTruncatedForModel, true);
  assert.match(String(rendered.outputPreview), /^{"stdout":"aaa/);
  assert.match(String(rendered.outputPreview), /TAIL_ERROR"}$/);
  assert.match(String(rendered.outputPreview), /middle truncated/);
});

test("tool result rendering exposes workspace path aliases for container runs", async () => {
  const previousHostWorkspace = process.env.REAPER_TBENCH_HOST_WORKSPACE;
  const previousAliases = process.env.REAPER_WORKSPACE_PATH_ALIASES;
  process.env.REAPER_TBENCH_HOST_WORKSPACE = "/tmp/reaper-tbench-abc/app";
  process.env.REAPER_WORKSPACE_PATH_ALIASES = "/app";
  try {
    const rendered = renderToolResultForModel({
      toolCallId: "read-log",
      name: "read_file",
      ok: true,
      durationMs: 10,
      args: { path: "/tmp/reaper-tbench-abc/app/log.stack" },
      output: {
        path: "/tmp/reaper-tbench-abc/app/log.stack",
        content: "input_path = '/tmp/reaper-tbench-abc/app/log.stack'",
      },
    });

    assert.deepEqual(rendered.workspacePathAliases, {
      "/tmp/reaper-tbench-abc/app": "/app",
      "/tmp/reaper-tbench-abc/app/log.stack": "/app/log.stack",
    });
  } finally {
    if (previousHostWorkspace === undefined) delete process.env.REAPER_TBENCH_HOST_WORKSPACE;
    else process.env.REAPER_TBENCH_HOST_WORKSPACE = previousHostWorkspace;
    if (previousAliases === undefined) delete process.env.REAPER_WORKSPACE_PATH_ALIASES;
    else process.env.REAPER_WORKSPACE_PATH_ALIASES = previousAliases;
  }
});

test("content index is cached for unchanged workspaces", async () => {
  const workspaceRoot = await createMediumWorkspace();
  const first = await prepareRuntimeContent({
    workspaceRoot,
    prompt: "Inspect feature files",
    maxContextTokens: 4000,
  });
  const cached = getCachedIndex(workspaceRoot);
  const second = await prepareRuntimeContent({
    workspaceRoot,
    prompt: "Inspect feature files",
    maxContextTokens: 4000,
  });

  assert.ok(cached);
  assert.equal(first.index.fingerprint, second.index.fingerprint);
  assert.equal(cached?.fingerprint, second.index.fingerprint);
});

test("runtime engine records content fingerprint and uses content prep on explicit tool runs", async () => {
  const workspaceRoot = await createMediumWorkspace();
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Read @src/app.ts and report the current answer.",
    tool_calls: [{ id: "1", name: "read_file", args: { path: "src/app.ts" } }],
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  const result = await engine.run();
  assert.ok(result.contentFingerprint);
  assert.equal(result.toolResults[0]?.ok, true);
});
