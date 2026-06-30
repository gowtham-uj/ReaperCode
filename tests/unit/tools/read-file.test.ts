import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readFileTool } from "../../../src/tools/read/read-file.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("readFileTool preserves text reads with line numbers", async () => {
  const workspace = await tempDir("reaper-read-text-");
  await writeFile(path.join(workspace, "hello.txt"), "alpha\nbeta\ngamma\n", "utf8");

  const result = await readFileTool(workspace, { path: "hello.txt", startLine: 2, endLine: 3 });

  if (result.kind !== "text") throw new Error(`expected text result, got ${result.kind}`);
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.equal(result.totalLines, 4);
  assert.equal(result.content, "2: beta\n3: gamma");
});

test("readFileTool returns image attachment payloads instead of forcing UTF-8 text", async () => {
  const workspace = await tempDir("reaper-read-image-");
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
  await writeFile(path.join(workspace, "logo.png"), png);

  const result = await readFileTool(workspace, { path: "logo.png" });

  if (result.kind !== "image") throw new Error(`expected image result, got ${result.kind}`);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes, png.length);
  assert.equal(result.base64, png.toString("base64"));
  assert.match(result.note ?? "", /Image file read as an attachment payload/);
});

test("readFileTool image reads still use unique basename fallback", async () => {
  const workspace = await tempDir("reaper-read-image-fallback-");
  await writeFile(path.join(workspace, "nested.gif"), Buffer.from("GIF89a", "ascii"));

  const result = await readFileTool(workspace, { path: "missing/nested.gif" });

  if (result.kind !== "image") throw new Error(`expected image result, got ${result.kind}`);
  assert.equal(result.mimeType, "image/gif");
  assert.equal(result.resolvedFrom, "missing/nested.gif");
  assert.equal(result.resolvedPath, "nested.gif");
});
