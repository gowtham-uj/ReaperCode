import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spillLargeToolResult } from "../../src/tools/executor.js";

const tinyStdout = "hello world\n";
const mediumStdout = "m".repeat(4_000);
// >8KB so spillover triggers. 12KB leaves comfortable headroom.
const bigStdout = "x".repeat(12_000);

test("spillLargeToolResult leaves small output untouched", async () => {
  const result = await spillLargeToolResult(
    { stdout: tinyStdout, stderr: "", exitCode: 0, wouldBlock: false },
    { id: "small-1" },
    "/tmp/nonexistent-workspace",
  );
  assert.ok(result);
  assert.equal(result.stdout, tinyStdout);
  assert.equal(result.spilloverPath, undefined);
});

test("spillLargeToolResult leaves medium output untouched", async () => {
  const result = await spillLargeToolResult(
    { stdout: mediumStdout, stderr: "", exitCode: 0, wouldBlock: false },
    { id: "medium-1" },
    "/tmp/nonexistent-workspace",
  );
  assert.ok(result);
  assert.equal(result.stdout, mediumStdout);
  assert.equal(result.spilloverPath, undefined);
});

test("spillLargeToolResult writes big output to a file and returns a short summary", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-spillover-"));
  try {
    const result = await spillLargeToolResult(
      { stdout: bigStdout, stderr: "", exitCode: 0, wouldBlock: false },
      { id: "abc-123" },
      workspace,
    );
    assert.ok(result);
    assert.equal(result.spilloverPath, path.join(workspace, ".reaper", "spillover", "abc-123.log"));
    assert.ok((result.stdout ?? "").length < 3_000, "summary should be far smaller than 8KB");
    assert.match(result.stdout ?? "", /truncated; full output written to .*abc-123\.log/);

    const written = await readFile(result.spilloverPath!, "utf8");
    assert.equal(written.length, bigStdout.length);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("spillLargeToolResult falls back gracefully when workspace is not writable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-spillover-unwritable-"));
  try {
    // A regular file cannot contain a child directory on any platform.
    const notDirectory = path.join(root, "not-a-directory");
    await writeFile(notDirectory, "x", "utf8");
    const result = await spillLargeToolResult(
      { stdout: bigStdout, stderr: "", exitCode: 0, wouldBlock: false },
      { id: "fallback-1" },
      path.join(notDirectory, "workspace"),
    );
    assert.ok(result);
    // Even when the spillover path is unwritable, the executor must still
    // return bounded stdout or the next model prompt can exceed context.
    assert.ok((result.stdout ?? "").length < 2_000, "fallback stdout should be bounded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
