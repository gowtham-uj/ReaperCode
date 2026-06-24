/**
 * content-prep memoization — Phase 2.3 regression. We verify:
 *   1. memoize: true returns identical result on identical inputs (cache hit).
 *   2. memoize: true with different toolResults misses the cache.
 *   3. memoize: false always recomputes.
 *   4. mcpRegistry or middlewares disable memoization even when opted in.
 *   5. clearContentPrepCache() drops the cache.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpWorkspace = mkdtempSync(join(tmpdir(), "reaper-prep-memo-"));

const {
  prepareRuntimeContent,
  clearContentPrepCache,
  contentPrepCacheSize,
} = await import("../../../src/runtime/content-prep.js");

function baseInput(overrides: Partial<Parameters<typeof prepareRuntimeContent>[0]> = {}) {
  return {
    workspaceRoot: tmpWorkspace,
    prompt: "show me the auth middleware",
    maxContextTokens: 8000,
    ...overrides,
  };
}

test("content-prep memoize: identical inputs return the same cached result", async () => {
  clearContentPrepCache();
  assert.equal(contentPrepCacheSize(), 0);

  const a = await prepareRuntimeContent(baseInput(), { memoize: true });
  assert.equal(contentPrepCacheSize(), 1);

  const b = await prepareRuntimeContent(baseInput(), { memoize: true });
  assert.equal(contentPrepCacheSize(), 1, "cache should still hold 1 entry after hit");
  // Same object identity proves cache hit (no recomputation).
  assert.equal(a, b);
});

test("content-prep memoize: different toolResults miss the cache", async () => {
  clearContentPrepCache();
  await prepareRuntimeContent(baseInput(), { memoize: true });
  await prepareRuntimeContent(
    baseInput({
      toolResults: [
        { name: "read_file", toolCallId: "t1", ok: true, durationMs: 1, output: "different content" },
      ],
    }),
    { memoize: true },
  );
  assert.equal(contentPrepCacheSize(), 2, "different toolResults should produce a new cache entry");
});

test("content-prep memoize: different prompt misses the cache", async () => {
  clearContentPrepCache();
  await prepareRuntimeContent(baseInput(), { memoize: true });
  await prepareRuntimeContent(baseInput({ prompt: "different prompt" }), { memoize: true });
  assert.equal(contentPrepCacheSize(), 2);
});

test("content-prep memoize: memoize: false always recomputes (cache stays empty)", async () => {
  clearContentPrepCache();
  await prepareRuntimeContent(baseInput(), { memoize: false });
  await prepareRuntimeContent(baseInput(), { memoize: false });
  assert.equal(contentPrepCacheSize(), 0, "memoize:false should never populate the cache");
});

test("content-prep memoize: middlewares disable memoization even when opted in", async () => {
  clearContentPrepCache();
  await prepareRuntimeContent(
    baseInput({
      middlewares: [
        {
          name: "noop",
          hook: "onContentPrep",
          priority: 0,
          middlewareApiVersion: 1,
          run: async (ctx: { state: unknown }) => ctx.state as never,
        },
      ],
    }),
    { memoize: true },
  );
  assert.equal(contentPrepCacheSize(), 0, "middlewares should disable memoization");
});

test("content-prep memoize: clearContentPrepCache drops the cache", async () => {
  clearContentPrepCache();
  await prepareRuntimeContent(baseInput(), { memoize: true });
  await prepareRuntimeContent(baseInput({ prompt: "other" }), { memoize: true });
  assert.equal(contentPrepCacheSize(), 2);
  clearContentPrepCache();
  assert.equal(contentPrepCacheSize(), 0);
});

test("content-prep memoize: bounded to MAX_CACHE_SIZE (32)", async () => {
  clearContentPrepCache();
  for (let i = 0; i < 40; i++) {
    await prepareRuntimeContent(baseInput({ prompt: `prompt-${i}` }), { memoize: true });
  }
  // After 40 inserts the cache should be capped at 32 (oldest dropped).
  assert.ok(contentPrepCacheSize() <= 32, `cache size ${contentPrepCacheSize()} exceeded cap`);
});

test("teardown", () => {
  clearContentPrepCache();
  try {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
