/**
 * Tests for the engine-level tool argument normalization.
 *
 * The engine's parser (`normalizeToolCallInput`) and the S8 shared
 * allowlist share a single source of truth via
 * `src/runtime/tool-args.ts`. The historic drift was a name present in
 * the args map but missing from the `isKnownToolName` set, which left
 * a call that the engine would neither strip (unknown) nor pass
 * (also unknown). Both surfaces are now derived from the same map;
 * this test exercises the exact functions the engine's parser uses.
 *
 * Everything here is keyed by canonical names. Aliases such as
 * `view_file` are resolved earlier, by `normalizeToolCall`, and
 * deliberately have no entry of their own — an alias that also had a
 * map entry would be a second source of truth for the same tool.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_TOOLS,
  getAllowedArgs,
  isKnownToolName,
  stripUnknownToolArgs,
} from "../../src/runtime/tool-args.js";

test("engine-level: file_view is recognized and exposes its canonical arg shape", () => {
  assert.equal(isKnownToolName("file_view"), true);
  assert.equal(KNOWN_TOOLS.has("file_view"), true);
  assert.deepEqual(getAllowedArgs("file_view"), ["path", "start_line", "window"]);
});

test("engine-level: retired view_file is not a name of its own here", () => {
  // `view_file` is an *alias*, resolved by `normalizeToolCall` before this
  // layer ever sees the call. It has no entry of its own, and its old
  // `startLine`/`endLine` arg names went with it — that arg set predates the
  // window semantics `file_view` actually uses.
  assert.equal(isKnownToolName("view_file"), false);
  assert.equal(KNOWN_TOOLS.has("view_file"), false);
  assert.deepEqual(getAllowedArgs("view_file"), []);
});

test("engine-level: stripUnknownToolArgs keeps file_view's declared args and drops the rest", () => {
  const input = {
    path: "/workspace/foo.ts",
    start_line: 10,
    window: 20,
    // bogus keys the parser should drop:
    foo: 1,
    bar: "baz",
    qux: { nested: true },
  };
  const out = stripUnknownToolArgs("file_view", input);
  assert.ok("cleaned" in out);
  assert.deepEqual(out.stripped.sort(), ["bar", "foo", "qux"]);
  assert.deepEqual(out.cleaned, {
    path: "/workspace/foo.ts",
    start_line: 10,
    window: 20,
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

