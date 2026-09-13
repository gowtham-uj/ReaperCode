/**
 * The preview proxy's one untrusted input is the request path. Everything it
 * proxies is derived from that path, so the parser is where the boundary
 * holds: it must reject anything that is not a preview request, any port the
 * OS would not let a dev server bind, and any text that only *looks* numeric.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parsePreviewPath } from "../../src/app-server/web/preview.js";

test("preview paths parse to a port and a rooted path", () => {
  assert.deepEqual(parsePreviewPath("/preview/5173"), { port: 5173, path: "/" });
  assert.deepEqual(parsePreviewPath("/preview/5173/"), { port: 5173, path: "/" });
  assert.deepEqual(parsePreviewPath("/preview/5173/a/b?x=1"), { port: 5173, path: "/a/b?x=1" });
});

test("non-preview paths are rejected", () => {
  assert.equal(parsePreviewPath("/api/files"), undefined);
  assert.equal(parsePreviewPath("/preview"), undefined);
  assert.equal(parsePreviewPath("/previews/5173"), undefined);
  assert.equal(parsePreviewPath("/"), undefined);
});

test("privileged and oversized ports are rejected", () => {
  assert.equal(parsePreviewPath("/preview/80"), undefined);
  assert.equal(parsePreviewPath("/preview/631"), undefined);
  assert.equal(parsePreviewPath("/preview/1023"), undefined);
  assert.equal(parsePreviewPath("/preview/65536"), undefined);
  assert.equal(parsePreviewPath("/preview/99999"), undefined);
});

test("port text that only looks numeric is rejected", () => {
  // Number("80abc") is NaN, but a lazy parseInt would read it as 80 and proxy ssh.
  assert.equal(parsePreviewPath("/preview/80abc"), undefined);
  assert.equal(parsePreviewPath("/preview/5173xyz"), undefined);
  assert.equal(parsePreviewPath("/preview/"), undefined);
});

test("the query string is preserved for the upstream request", () => {
  assert.deepEqual(parsePreviewPath("/preview/5173?foo=1"), { port: 5173, path: "/?foo=1" });
});
