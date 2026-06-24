import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spillLargeToolResult } from "../../src/tools/executor.js";

const tinyStdout = "hello world\n";
// >65KB so spillover triggers. 80KB leaves comfortable headroom.
const bigStdout = "x".repeat(80_000);

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
    assert.ok((result.stdout ?? "").length < 20_000, "summary should be far smaller than 65KB");
    assert.match(result.stdout ?? "", /truncated; full output written to .*abc-123\.log/);

    const written = await readFile(result.spilloverPath!, "utf8");
    assert.equal(written.length, bigStdout.length);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("spillLargeToolResult falls back gracefully when workspace is not writable", async () => {
  // A path that does not exist: mkdir will throw, we should still get a result back.
  const result = await spillLargeToolResult(
    { stdout: bigStdout, stderr: "", exitCode: 0, wouldBlock: false },
    { id: "fallback-1" },
    "/this/path/does/not/exist/and/cannot/be/created",
  );
  assert.ok(result);
  // Even when the spillover path is unwritable, the executor must still
  // return a result with a bounded-size stdout (otherwise the model call
  // would block on an unbounded prompt next time).
  assert.ok((result.stdout ?? "").length < 20_000, "fallback stdout should be bounded");
});
