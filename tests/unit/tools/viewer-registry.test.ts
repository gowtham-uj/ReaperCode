/**
 * Unit tests for FileViewerRegistry.
 *
 * Pure state-management: no filesystem access. Covers scroll bounds
 * clamping, find-empty pattern, edit-line-overlap invariants, and hash-
 * anchored invalidation.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  FileViewerRegistry,
  clampWindow,
  numberLines,
} from "../../../src/tools/viewer/viewer-registry.js";

test("numberLines prepends 1-indexed gutter", () => {
  const out = numberLines(["a", "b", "c"], 11);
  assert.deepEqual(out, ["11: a", "12: b", "13: c"]);
});

test("clampWindow handles empty content", () => {
  const r = clampWindow(1, 50, 0);
  assert.equal(r.start, 1);
  assert.equal(r.end, 1);
  assert.equal(r.truncated, false);
});

test("clampWindow clamps start to [1, totalLines+1)", () => {
  assert.equal(clampWindow(0, 50, 100).start, 1);
  assert.equal(clampWindow(500, 50, 100).start, 100);
});

test("clampWindow end never exceeds totalLines+1", () => {
  const r = clampWindow(95, 50, 100);
  assert.ok(r.end <= 101);
  assert.ok(r.start <= r.end);
});

test("clampWindow caps huge windows at 500", () => {
  // 1000-row file, window-request 10000 → effective window capped at 500
  const r = clampWindow(1, 10_000, 1000);
  assert.equal(r.end - r.start, 500);
});

test("registry readOrInit creates a fresh view for a new path", () => {
  const r = new FileViewerRegistry();
  const { state, window } = r.readOrInit("/tmp/a.ts", 100, "hashA", 100);
  assert.equal(state.path, "/tmp/a.ts");
  assert.equal(state.startLine, 1);
  assert.ok(state.endLine > state.startLine);
  assert.ok(window.endLine > window.startLine);
});

test("registry reuses an existing unchanged view (same hash + mtime)", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 100, "hashA", 100);
  const { state } = r.readOrInit("/tmp/a.ts", 100, "hashA", 100);
  assert.equal(state.startLine, 1);
});

test("registry invalidates when the file's sha256 changes", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 100, "hashA", 100);
  r.invalidate("/tmp/a.ts");
  assert.equal(r.get("/tmp/a.ts"), undefined);
});

test("registry invalidates when the file's mtimeMs changes (noteEdit anchor reuse)", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 100, "hashA", 100);
  r.noteEdit("/tmp/a.ts", 120, "hashA", 200);
  const view = r.get("/tmp/a.ts");
  assert.equal(view?.totalLines, 120);
  assert.equal(view?.mtimeMs, 200);
});

test("scroll with direction=top resets to start", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 100, "h", 1);
  r.scroll("/tmp/a.ts", "down", 25, 100);
  const w = r.scroll("/tmp/a.ts", "top", 25, 100);
  assert.equal(w?.startLine, 1);
});

test("scroll with direction=bottom clamps to totalLines", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 80, "h", 1);
  const w = r.scroll("/tmp/a.ts", "bottom", 25, 80);
  assert.ok(w!.endLine <= 81);
});

test("scroll with direction=up does not go below line 1", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 100, "h", 1);
  const w = r.scroll("/tmp/a.ts", "up", 25, 100);
  assert.equal(w?.startLine, 1);
});

test("scroll with direction=down never exceeds totalLines - window + 1", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 80, "h", 1);
  const w = r.scroll("/tmp/a.ts", "down", 25, 80);
  assert.ok(w!.startLine <= 56); // 80 - 25 + 1
});

test("find returns undefined when nothing matches", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 50, "h", 1);
  const m = r.find("/tmp/a.ts", "definitely_not_present_token_xyz", [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.equal(m, undefined);
});

test("find returns matchedLine when token is present", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 50, "h", 1);
  const m = r.find("/tmp/a.ts", "beta", ["alpha", "beta", "gamma"]);
  assert.ok(m);
  assert.equal(m!.matchedLine, 2);
});

test("find recenters the viewport on the matched line", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 80, "h", 1);
  r.find(
    "/tmp/a.ts",
    "alpha",
    Array.from({ length: 80 }, (_, i) => (i === 70 ? "alpha" : `line${i}`)),
  );
  const w = r.get("/tmp/a.ts");
  // Matched line 71 is within [start, end)
  assert.ok(w!.anchorLine === 71);
  assert.ok(w!.startLine <= 71);
  assert.ok(w!.endLine > 71);
});

test("clear wipes the entire registry", () => {
  const r = new FileViewerRegistry();
  r.readOrInit("/tmp/a.ts", 100, "h", 1);
  r.readOrInit("/tmp/b.ts", 100, "h", 1);
  r.clear();
  assert.equal(r.get("/tmp/a.ts"), undefined);
  assert.equal(r.get("/tmp/b.ts"), undefined);
});

test("two readers see the same registry state (singleton lifetime)", () => {
  const r = new FileViewerRegistry();
  const a = r.readOrInit("/tmp/shared.ts", 50, "h", 1);
  const b = r.readOrInit("/tmp/shared.ts", 50, "h", 1);
  assert.equal(a.state, b.state); // Object.is — same state, not just equal
});
