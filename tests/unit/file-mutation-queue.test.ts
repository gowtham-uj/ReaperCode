import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileMutationQueue } from "../../src/tools/write/file-mutation-queue.js";
import { applyEditFileContent, editFileTool } from "../../src/tools/write/edit-file.js";
import { replaceInFileTool } from "../../src/tools/write/replace-in-file.js";
import { writeFileTool } from "../../src/tools/write/write-file.js";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("FileMutationQueue serializes operations for the same real file", async () => {
  const dir = await tempDir("reaper-mutation-queue-");
  const file = path.join(dir, "a.txt");
  await writeFile(file, "", "utf8");
  const queue = new FileMutationQueue();
  const events: string[] = [];

  await Promise.all([
    queue.run(file, async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push("first-end");
    }),
    queue.run(file, async () => {
      events.push("second-start");
      events.push("second-end");
    }),
  ]);

  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
  assert.equal(queue.size, 0);
});

test("FileMutationQueue allows different files to run concurrently and cleans up after failures", async () => {
  const dir = await tempDir("reaper-mutation-queue-");
  const queue = new FileMutationQueue();
  const events: string[] = [];
  const results = await Promise.allSettled([
    queue.run(path.join(dir, "a.txt"), async () => { events.push("a"); throw new Error("boom"); }),
    queue.run(path.join(dir, "b.txt"), async () => { events.push("b"); }),
  ]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "fulfilled");
  assert.equal(events.includes("b"), true);
  assert.equal(queue.size, 0);
});

test("FileMutationQueue serializes symlinked paths that resolve to the same real file", async (t) => {
  const dir = await tempDir("reaper-mutation-symlink-");
  const file = path.join(dir, "real.txt");
  const link = path.join(dir, "link.txt");
  await writeFile(file, "", "utf8");
  try {
    await symlink(file, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation requires elevated privileges on this platform");
      return;
    }
    throw error;
  }
  const queue = new FileMutationQueue();
  const events: string[] = [];

  await Promise.all([
    queue.run(file, async () => { events.push("real-start"); await new Promise((resolve) => setTimeout(resolve, 20)); events.push("real-end"); }),
    queue.run(link, async () => { events.push("link-start"); events.push("link-end"); }),
  ]);

  assert.deepEqual(events, ["real-start", "real-end", "link-start", "link-end"]);
});

test("applyEditFileContent applies multi-edits atomically against original content", () => {
  const original = "one\ntwo\nthree\n";
  const result = applyEditFileContent(original, {
    path: "x.txt",
    edits: [
      { oldString: "one", newString: "ONE" },
      { oldString: "three", newString: "THREE" },
    ],
  });
  assert.equal(result.content, "ONE\ntwo\nTHREE\n");
  assert.equal(result.appliedEdits, 2);
});

test("applyEditFileContent rejects overlapping multi-edits before mutating content", () => {
  assert.throws(
    () => applyEditFileContent("abcde", {
      path: "x.txt",
      edits: [
        { oldString: "abc", newString: "ABC" },
        { oldString: "bcd", newString: "BCD" },
      ],
    }),
    /overlap/i,
  );
});

test("actual write tools use queued writes and preserve final file consistency", async () => {
  const dir = await tempDir("reaper-write-tools-queue-");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFileTool(dir, { path: "src/a.txt", content: "one\ntwo\nthree\n" });
  await Promise.all([
    replaceInFileTool(dir, { path: "src/a.txt", oldString: "one", newString: "ONE" }),
    editFileTool(dir, { path: "src/a.txt", edits: [{ oldString: "three", newString: "THREE" }] }),
  ]);
  const finalContent = await readFile(path.join(dir, "src/a.txt"), "utf8");
  assert.equal(finalContent, "ONE\ntwo\nTHREE\n");
});
