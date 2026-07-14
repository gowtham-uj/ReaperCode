import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import { executeScratchpad, scratchpadPath } from "../../src/tools/memory/scratchpad.js";
import { ScratchpadArgsSchema } from "../../src/tools/types.js";

async function tempWs(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "reaper-scratch-"));
}

test("ScratchpadArgsSchema accepts append/read/clear", () => {
  assert.equal(ScratchpadArgsSchema.parse({ action: "read" }).action, "read");
  assert.equal(
    ScratchpadArgsSchema.parse({ action: "append", note: "hello", label: "plan" }).note,
    "hello",
  );
  assert.equal(ScratchpadArgsSchema.parse({ action: "clear" }).action, "clear");
});

test("executeScratchpad append then read round-trips", async () => {
  const ws = await tempWs();
  const appended = await executeScratchpad(
    { action: "append", note: "decide to use worktrees", label: "decision" },
    { workspaceRoot: ws },
  );
  assert.equal(appended.appended, true);
  assert.ok(appended.bytes > 0);
  assert.ok(existsSync(scratchpadPath(ws)));

  const read = await executeScratchpad({ action: "read" }, { workspaceRoot: ws });
  assert.ok(read.content?.includes("decide to use worktrees"));
  assert.ok(read.content?.includes("decision"));
});

test("executeScratchpad deduplicates an identical labeled note", async () => {
  const ws = await tempWs();
  const note = "tenant identity is the pair (tenantId, eventId)";
  const first = await executeScratchpad(
    { action: "append", note, label: "architecture" },
    { workspaceRoot: ws },
  );
  const second = await executeScratchpad(
    { action: "append", note, label: "architecture" },
    { workspaceRoot: ws },
  );
  const onDisk = await readFile(scratchpadPath(ws), "utf8");
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  assert.equal(second.deduplicated, true);
  assert.equal(onDisk.match(/tenant identity/g)?.length, 1);
});

test("executeScratchpad clear empties the file", async () => {
  const ws = await tempWs();
  await executeScratchpad({ action: "append", note: "temp" }, { workspaceRoot: ws });
  const cleared = await executeScratchpad({ action: "clear" }, { workspaceRoot: ws });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.bytes, 0);
  const onDisk = await readFile(scratchpadPath(ws), "utf8");
  assert.equal(onDisk, "");
});

test("executeScratchpad append requires note", async () => {
  const ws = await tempWs();
  await assert.rejects(
    () => executeScratchpad({ action: "append" }, { workspaceRoot: ws }),
    /non-empty note/,
  );
});

test("executeScratchpad read returns empty when missing", async () => {
  const ws = await tempWs();
  const read = await executeScratchpad({ action: "read" }, { workspaceRoot: ws });
  assert.equal(read.content, "");
  assert.equal(read.bytes, 0);
});
