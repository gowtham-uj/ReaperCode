import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  BashOutputAccumulator,
  attachBashStream,
  type BashOutputSnapshot,
} from "../../../../src/tools/bash/partial-update.js";

test("BashOutputAccumulator keeps a small bounded tail for in-budget output", () => {
  const acc = new BashOutputAccumulator({ maxBytes: 1024, maxLines: 50 });
  acc.append("line one\nline two\nline three\n");
  const snap = acc.snapshot();
  assert.equal(snap.truncated, false);
  assert.equal(snap.truncatedBy, null);
  assert.match(snap.content, /line one/);
  assert.match(snap.content, /line three/);
});

test("BashOutputAccumulator marks truncation by bytes once the rolling tail overflows", () => {
  const acc = new BashOutputAccumulator({ maxBytes: 32, maxLines: 1000 });
  for (let i = 0; i < 50; i += 1) {
    acc.append(`entry-${i}-${"x".repeat(16)}\n`);
  }
  const snap = acc.snapshot();
  assert.equal(snap.truncated, true);
  assert.equal(snap.truncatedBy, "bytes");
  assert.ok(snap.totalBytes > 32);
});

test("BashOutputAccumulator opens a temp file when truncation trips and exposes its path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-accum-"));
  const tempPath = path.join(dir, "spilled.log");
  const acc = new BashOutputAccumulator({
    maxBytes: 16,
    maxLines: 5,
    tempFilePath: tempPath,
  });
  for (let i = 0; i < 50; i += 1) {
    acc.append(`line-${i}\n`);
  }
  const snap = acc.snapshot({ persistIfTruncated: true });
  acc.finish();
  await acc.closeTempFile();
  assert.equal(snap.truncated, true);
  assert.equal(snap.fullOutputPath, tempPath);
  const persisted = await readFile(tempPath, "utf8");
  assert.match(persisted, /line-0/);
  assert.match(persisted, /line-49/);
});

test("attachBashStream forwards bounded snapshots to the callback when stdout emits chunks", () => {
  const acc = new BashOutputAccumulator({ maxBytes: 64, maxLines: 10 });
  const seen: BashOutputSnapshot[] = [];
  const writable = new (class {
    listeners: Array<(chunk: Buffer | string) => void> = [];
    on(_evt: "data", cb: (chunk: Buffer | string) => void) {
      this.listeners.push(cb);
    }
    emit(chunk: string) {
      for (const cb of this.listeners) cb(Buffer.from(chunk, "utf-8"));
    }
  })();
  attachBashStream(
    { stdout: writable as unknown as NodeJS.ReadableStream, stderr: null },
    acc,
    { onPartialUpdate: (s) => seen.push(s) },
  );
  writable.emit("alpha\nbeta\ngamma\n");
  assert.ok(seen.length >= 1, "callback should fire on first chunk");
  const last = seen.at(-1)!;
  assert.match(last.content, /alpha/);
});