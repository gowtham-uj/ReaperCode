import test from "node:test";
import assert from "node:assert/strict";

import { optimizeToolCallBatch, fanoutDeduplicatedResults } from "../../src/execution/optimizer.js";

function call(name: string, args: Record<string, unknown> = {}, id = ""): any {
  return { id, name, args };
}

test("optimizer deduplicates identical reads", () => {
  const calls = [
    call("read_file", { path: "src/a.ts" }, "1"),
    call("read_file", { path: "src/a.ts" }, "2"),
    call("read_file", { path: "src/b.ts" }, "3"),
  ];
  const result = optimizeToolCallBatch(calls);
  assert.equal(result.uniquePlan.length, 2);
  assert.equal(result.uniqueIndex[0], 0);
  assert.equal(result.uniqueIndex[1], 0);
  assert.equal(result.uniqueIndex[2], 1);
});

test("optimizer deduplicates identical greps and list_directory calls", () => {
  const calls = [
    call("grep_search", { pattern: "TODO", path: "src" }, "1"),
    call("grep_search", { pattern: "TODO", path: "src" }, "2"),
    call("list_directory", { path: "." }, "3"),
    call("list_directory", { path: "." }, "4"),
  ];
  const result = optimizeToolCallBatch(calls);
  assert.equal(result.uniquePlan.length, 2);
});

test("optimizer does not deduplicate writes or shell commands", () => {
  const calls = [
    call("write_file", { path: "a.ts" }, "1"),
    call("write_file", { path: "a.ts" }, "2"),
    call("run_shell_command", { cmd: "ls" }, "3"),
    call("run_shell_command", { cmd: "ls" }, "4"),
  ];
  const result = optimizeToolCallBatch(calls);
  assert.equal(result.uniquePlan.length, 4, "writes and shell should not collapse");
});

test("optimizer caps concurrency for large read batches", () => {
  const calls = Array.from({ length: 30 }, (_, i) => call("read_file", { path: `f${i}.ts` }, `${i}`));
  const result = optimizeToolCallBatch(calls);
  assert.ok(result.concurrency <= 8, "concurrency should be capped at 8");
  assert.ok(result.concurrency >= 1, "concurrency should be at least 1");
  assert.equal(result.uniquePlan.length, 30);
});

test("optimizer keeps concurrency at least 1 for single-entry pools", () => {
  const result = optimizeToolCallBatch([call("read_file", { path: "a.ts" })]);
  assert.equal(result.concurrency, 1);
});

test("fanoutDeduplicatedResults returns one result per original call", () => {
  const calls = [
    call("read_file", { path: "a.ts" }, "1"),
    call("read_file", { path: "a.ts" }, "2"),
    call("read_file", { path: "b.ts" }, "3"),
  ];
  const opt = optimizeToolCallBatch(calls);
  // Simulate execution: two results, one per unique plan entry.
  const uniqueResults: string[] = ["A", "B"];
  const fanned = fanoutDeduplicatedResults(uniqueResults, opt.uniqueIndex);
  assert.deepEqual(fanned, ["A", "A", "B"]);
});
