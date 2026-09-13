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
/**
 * The pointer in the notice must name the file that holds everything.
 *
 * The bash tool keeps a bounded in-memory buffer, so the artifact it writes
 * after a large command is a slice of the output, not all of it; the complete
 * stream goes to the run's process log while the command runs. The notice read
 * "Full output written to <artifact>" and pointed at the slice. Measured on
 * `cat` of a 42MB log: the artifact held 262,112 bytes (0.62%) and the process
 * log held all 42,734,826, so a model that trusted the pointer would analyse
 * the tail of a log and report conclusions about the whole of it.
 */
test("the full-output notice names the complete file, not the bounded artifact", async () => {
  const artifact = "/workspace/.reaper/artifacts/bash/preview.txt";
  const complete = "/workspace/.reaper/sessions/run-1/artifacts/processes/call-1.log";
  const result = await buildBashResultOutput(
    { command: "cat app.log" } as any,
    {
      stdout: sample,
      stderr: "",
      exit_code: 0,
      interrupted: false,
      persisted_output_path: artifact,
      persisted_output_size: sample.length,
      full_output_path: complete,
      full_output_size: 42_734_826,
    } as any,
    "/workspace",
  );
  assert.match(result.content, new RegExp(`Full output written to ${complete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(
    result.content,
    new RegExp(`Full output written to ${artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "the bounded artifact must not be presented as the complete output",
  );
  // Both paths are named, so a reader can tell why there are two and which is
  // which instead of guessing.
  assert.match(result.content, /hold only the newest part/);
});

test("without a complete-output pointer the artifact is still named", async () => {
  // The output never exceeded the buffer, so the artifact really is everything
  // and saying so is honest rather than a fallback.
  const result = await buildBashResultOutput(
    { command: "echo big" } as any,
    baseOutput(sample, sample.length),
    "/workspace",
  );
  assert.match(result.content, /Full output written to \/workspace\/\.reaper\/artifacts\/bash\/test\.txt/);
  assert.doesNotMatch(result.content, /hold only the newest part/, "no second path means no disclaimer");
});

test("the camelCase spelling from the executor is understood too", async () => {
  /*
   * The tool's schema names these fields in snake_case while the executor's
   * bash case returns camelCase and never converts. Reading only one spelling
   * would silently fall back to the artifact on whichever path used the other,
   * which is the same bug wearing a different name.
   */
  const complete = "/workspace/.reaper/sessions/run-1/artifacts/processes/call-2.log";
  const result = await buildBashResultOutput(
    { command: "cat app.log" } as any,
    {
      stdout: sample,
      stderr: "",
      exit_code: 0,
      interrupted: false,
      persisted_output_path: "/workspace/.reaper/artifacts/bash/preview.txt",
      persisted_output_size: sample.length,
      fullOutputPath: complete,
      fullOutputSize: 42_734_826,
    } as any,
    "/workspace",
  );
  assert.match(result.content, new RegExp(complete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
