import test from "node:test";
import assert from "node:assert/strict";

import { bm25SearchTools, resetBM25Index, getIndexedToolCount } from "../../src/tools/bm25-search.js";
import { buildDescriptorsFromRegistry, resetDescriptors } from "../../src/tools/descriptor-builder.js";
import { executeSearchTools } from "../../src/tools/write/search-tools.js";

/**
 * Phase 2 smoke test: BM25 search returns relevant results.
 */
test("Phase 2: BM25 search returns relevant results for 'shell command'", async () => {
  resetDescriptors();
  resetBM25Index();
  buildDescriptorsFromRegistry();

  const results = bm25SearchTools("shell command", 6);
  assert.ok(results.length > 0, "should return results for 'shell command'");
  // bash should be near the top
  const bashRank = results.findIndex((r) => r.name === "bash");
  assert.ok(bashRank >= 0 && bashRank <= 2, `bash should be in top 3 results, got rank ${bashRank}`);

  resetDescriptors();
  resetBM25Index();
});

test("Phase 2: BM25 search returns relevant results for 'create a new file'", async () => {
  resetDescriptors();
  resetBM25Index();
  buildDescriptorsFromRegistry();

  const results = bm25SearchTools("create a new file", 6);
  assert.ok(results.length > 0, "should return results for 'create a new file'");
  // write_file should be near the top
  const writeFileRank = results.findIndex((r) => r.name === "write_file");
  assert.ok(writeFileRank >= 0 && writeFileRank <= 2, `write_file should be in top 3 results, got rank ${writeFileRank}`);

  resetDescriptors();
  resetBM25Index();
});

test("Phase 2: BM25 search returns relevant results for 'read file content'", async () => {
  resetDescriptors();
  resetBM25Index();
  buildDescriptorsFromRegistry();

  const results = bm25SearchTools("read file content", 6);
  assert.ok(results.length > 0, "should return results for 'read file content'");
  // file_view or read_file should be in results
  const hasReader = results.some((r) => ["file_view", "read_file", "view_file"].includes(r.name));
  assert.ok(hasReader, "should include a file reading tool");

  resetDescriptors();
  resetBM25Index();
});

test("Phase 2: BM25 search returns empty for nonsense query", async () => {
  resetDescriptors();
  resetBM25Index();
  buildDescriptorsFromRegistry();

  const results = bm25SearchTools("zzzznonexistent", 6);
  assert.equal(results.length, 0, "should return no results for nonsense query");

  resetDescriptors();
  resetBM25Index();
});

test("Phase 2: executeSearchTools uses BM25 and returns matches", async () => {
  resetDescriptors();
  resetBM25Index();

  const result = executeSearchTools("run a shell command", "test-run");
  assert.ok(result.total_tools > 0, "should report total tools");
  assert.ok(result.matches.length > 0, "should return matches");
  // bash should be in the matches
  const hasBash = result.matches.some((m) => m.name === "bash");
  assert.ok(hasBash, "bash should be in the matches");

  resetDescriptors();
  resetBM25Index();
});

test("Phase 2: executeSearchTools select: prefix still works", async () => {
  resetDescriptors();
  resetBM25Index();

  const result = executeSearchTools("select:write_file", "test-run");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.name, "write_file");
  assert.ok(result.discovered.includes("write_file"));

  resetDescriptors();
  resetBM25Index();
});
