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

test("Reaper's own services are refused as preview targets", () => {
  /*
   * These are the ports the browser and its live view run on. Forwarding to
   * them would hand a browser client raw CDP or Steel's unscoped cast socket,
   * which is the authority the scoped pane exists to withhold. They are
   * reserved by default so an unconfigured proxy still refuses them.
   */
  assert.equal(parsePreviewPath("/preview/9222/json/version"), undefined);
  assert.equal(parsePreviewPath("/preview/9223/json/version"), undefined);
  assert.equal(parsePreviewPath("/preview/3000/v1/sessions/cast"), undefined);
  // A neighbouring dev port is still proxied: the denylist names two services,
  // not a range.
  assert.deepEqual(parsePreviewPath("/preview/3001/"), { port: 3001, path: "/" });
});

test("reserved ports follow the configured endpoints", () => {
  /*
   * The endpoint moved once (Chrome's 9222 to Steel's 3000), so the refusal
   * is derived from configuration rather than hardcoded. A gateway told to
   * attach to Steel on another port must refuse *that* port.
   */
  const reserved = new Set([9222, 9223, 4321]);
  assert.equal(parsePreviewPath("/preview/4321/", reserved), undefined);
  assert.deepEqual(parsePreviewPath("/preview/3000/", reserved), { port: 3000, path: "/" });
});
