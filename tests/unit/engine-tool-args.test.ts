/**
 * Tests for the engine-level tool argument normalization.
 *
 * The engine's parser (`normalizeToolCallInput`) and the S8 shared
 * allowlist share a single source of truth via
 * `src/runtime/tool-args.ts`. The "view_file drift" bug was that
 * `view_file` was in the args map but missing from the
 * `isKnownToolName` set, so a model could issue a `view_file` call
 * that the engine would not strip (because unknown) and not pass
 * (because also unknown). The fix unifies both surfaces; this test
 * exercises the exact functions the engine's parser uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_TOOLS,
  getAllowedArgs,
  isKnownToolName,
  stripUnknownToolArgs,
} from "../../src/runtime/tool-args.js";

test("engine-level: view_file is recognized (regression for S8 drift)", () => {
  assert.equal(isKnownToolName("view_file"), true);
  assert.equal(KNOWN_TOOLS.has("view_file"), true);
  // The same name yields the documented arg set.
  assert.deepEqual(getAllowedArgs("view_file"), ["path", "startLine", "endLine"]);
});

test("engine-level: stripUnknownToolArgs keeps view_file's declared args and drops the rest", () => {
  const input = {
    path: "/workspace/foo.ts",
    startLine: 10,
    endLine: 20,
    // bogus keys the parser should drop:
    foo: 1,
    bar: "baz",
    qux: { nested: true },
  };
  const out = stripUnknownToolArgs("view_file", input);
  assert.ok("cleaned" in out);
  assert.deepEqual(out.stripped.sort(), ["bar", "foo", "qux"]);
  assert.deepEqual(out.cleaned, {
    path: "/workspace/foo.ts",
    startLine: 10,
    endLine: 20,
  });
  // Critically: the input object was NOT mutated.
  assert.equal((input as Record<string, unknown>).foo, 1);
  assert.equal((input as Record<string, unknown>).bar, "baz");
});

test("engine-level: stripUnknownToolArgs returns error for unknown tool", () => {
  const out = stripUnknownToolArgs("not_a_real_tool", { path: "/x" });
  assert.ok("error" in out);
  assert.equal(out.error, "unknown_tool");
});

test("engine-level: stripUnknownToolArgs treats empty-args known tool as known", () => {
  // inspect_environment has no args but IS a known tool. The
  // implementation must NOT classify it as unknown just because
  // the args list is empty.
  const out = stripUnknownToolArgs("inspect_environment", {});
  assert.ok("cleaned" in out);
  assert.deepEqual(out.cleaned, {});
  assert.deepEqual(out.stripped, []);
});

test("engine-level: read_file and view_file have parallel arg shapes", () => {
  // The two file-reading tools should accept the same key set. If
  // they ever drift, a `view_file` call with only `path` would
  // be misclassified.
  assert.deepEqual(getAllowedArgs("read_file"), getAllowedArgs("view_file"));
});
