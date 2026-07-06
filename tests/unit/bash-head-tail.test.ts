import test from "node:test";
import assert from "node:assert/strict";

import { buildBashResultOutput } from "../../src/tools/bash/result.js";

function baseOutput(stdout: string, persistedSize: number) {
  return {
    stdout,
    stderr: "",
    exit_code: 0,
    interrupted: false,
    persisted_output_path: "/workspace/.reaper/artifacts/bash/test.txt",
    persisted_output_size: persistedSize,
  };
}

const sample = (() => {
  let s = "HEAD_START\n";
  for (let i = 0; i < 50_000; i += 1) s += `line ${i}\n`;
  s += "TAIL_END";
  return s;
})();

test("bash head+tail preserves the first 1.2K and the last 1.2K", async () => {
  const result = await buildBashResultOutput(
    { command: "echo big" } as any,
    baseOutput(sample, sample.length),
    "/workspace",
    { bashHeadTailEnabled: true, bashHeadPreviewChars: 1_200, bashTailPreviewChars: 1_200 },
  );
  assert.match(result.content, /HEAD_START/, "head should be preserved");
  assert.match(result.content, /TAIL_END/, "tail should be preserved");
  assert.match(result.content, /chars truncated/, "truncation marker should be present");
  // Inline content should be smaller than the full body.
  const inline = result.content.length;
  assert.ok(inline < sample.length, `inline (${inline}) should be smaller than full body (${sample.length})`);
});

test("bash head-only legacy mode (bashHeadTailEnabled: false) keeps the first chunk only", async () => {
  const result = await buildBashResultOutput(
    { command: "echo big" } as any,
    baseOutput(sample, sample.length),
    "/workspace",
    { bashHeadTailEnabled: false, bashHeadPreviewChars: 1_200, bashTailPreviewChars: 1_200 },
  );
  assert.match(result.content, /HEAD_START/, "head should be preserved");
  assert.doesNotMatch(result.content, /TAIL_END/, "tail should NOT be preserved in legacy mode");
  assert.match(result.content, /output persisted to/, "legacy mode should use the old notice");
});