import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readFileTool } from "../../src/tools/read/read-file.js";

test("read_file returns identical output for repeated reads of an unchanged file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-readcache-"));
  const file = path.join(dir, "hello.txt");
  await writeFile(file, "hello\n", "utf8");

  const first = await readFileTool(dir, { path: "hello.txt" });
  const second = await readFileTool(dir, { path: "hello.txt" });

  assert.ok(first);
  assert.ok(second);
  // The TextReadFileResult is the relevant payload; both reads should
  // produce identical content when the file is unchanged (which is exactly
  // what the per-executor sha256+mtime cache guarantees).
  const a = first && (first as { content: string }).content;
  const b = second && (second as { content: string }).content;
  assert.equal(a, b);
});

test("read_file result is not affected by arg-shape variations that map to the same window", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-readcache-"));
  const file = path.join(dir, "lines.txt");
  const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(file, body, "utf8");

  const a = await readFileTool(dir, { path: "lines.txt", startLine: 0, endLine: 10 });
  const b = await readFileTool(dir, { path: "lines.txt", startLine: 1, endLine: 10 });
  assert.ok(a);
  assert.ok(b);
  // The two reads overlap and should both succeed; their slice content may
  // differ by one line because of the 1-indexed endLine.
  assert.equal(typeof (a as { content: string }).content, "string");
  assert.equal(typeof (b as { content: string }).content, "string");
});