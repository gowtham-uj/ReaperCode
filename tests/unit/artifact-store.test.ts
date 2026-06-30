import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "../../src/artifacts/store.js";

function newStore(): { store: ArtifactStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "reaper-artifact-"));
  return { store: new ArtifactStore(dir), dir };
}

test("put and get return the full artifact and metadata", async () => {
  const { store, dir } = newStore();
  try {
    const artifact = await store.put("tool_output", "hello\nworld\n", { sourceTool: "bash" });
    assert.equal(artifact.kind, "tool_output");
    assert.equal(artifact.sourceTool, "bash");
    const fetched = await store.get(artifact.artifactId);
    assert.equal(fetched.content, "hello\nworld\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read returns a line range with truncation metadata", async () => {
  const { store, dir } = newStore();
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const artifact = await store.put("verification_log", lines);
    const window = await store.read(artifact.artifactId, { startLine: 10, endLine: 12 });
    assert.equal(window.totalLines, 100);
    assert.equal(window.lines.length, 3);
    assert.equal(window.lines[0]?.line, 10);
    assert.equal(window.lines[0]?.content, "line 10");
    assert.equal(window.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read pattern returns matching lines with line numbers", async () => {
  const { store, dir } = newStore();
  try {
    const content = [
      "info: starting",
      "warn: deprecated",
      "info: done",
      "error: failed",
    ].join("\n");
    const artifact = await store.put("tool_output", content);
    const matches = await store.read(artifact.artifactId, { pattern: "^warn:|^error:" });
    assert.equal(matches.lines.length, 2);
    assert.equal(matches.lines[0]?.content, "warn: deprecated");
    assert.equal(matches.lines[1]?.content, "error: failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read jsonPath resolves nested keys and array indices", async () => {
  const { store, dir } = newStore();
  try {
    const content = JSON.stringify({
      run: { id: "abc", status: "ok", stats: { passed: 3, failed: 0 } },
      tests: [{ name: "a" }, { name: "b" }],
    });
    const artifact = await store.put("verification_log", content);
    const id = await store.read(artifact.artifactId, { jsonPath: "run.id" });
    assert.match(id.lines[0]?.content ?? "", /"abc"/);
    const tests = await store.read(artifact.artifactId, { jsonPath: "tests[0].name" });
    assert.match(tests.lines[0]?.content ?? "", /"a"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read maxBytes truncates the returned window", async () => {
  const { store, dir } = newStore();
  try {
    const content = "a".repeat(10_000);
    const artifact = await store.put("tool_output", content);
    const result = await store.read(artifact.artifactId, { maxBytes: 200 });
    assert.equal(result.truncated, true);
    assert.ok(result.lines[0]?.content.length && result.lines[0].content.length <= 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
