/**
 * The three ways a body-taking helper in the sandbox can be silently broken.
 *
 * Every one of these was a real bug found by running the calls against a real
 * browser, and none of them is visible from the host side. The pattern is the
 * same in all three cases: the pieces exist, the host answers correctly, and the
 * sandbox stitches them together wrongly, so the failure reads as the model's
 * own mistake.
 *
 *   1. The arm replies with `{ token }` and the collect receives the object, so
 *      the lookup key is `[object Object]` and every popup "never appeared".
 *   2. A helper that produces a live object returns a handle, and a handle is
 *      not a node, so `popup.url()` fails with "is not a function" while the
 *      popup is open and usable.
 *   3. The roots were built inline in the returned object, so a trigger body one
 *      frame down saw `page` as a free variable and threw "page is not defined".
 *
 * They are checked in the source rather than by running a browser, because each
 * is a shape rather than a behaviour and the shape is what went wrong. The
 * integration suite covers the behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../src/browser/remote-page-source.ts", import.meta.url), "utf8");

test("an arm's token is extracted rather than passed through as the object", () => {
  /*
   * The first bug. The host answers `{ token }`, and `collectDownload(armed)`
   * stringifies to `[object Object]`, so the armed wait is never found and the
   * call reports that nothing arrived.
   */
  assert.match(source, /const token = armedDownload && typeof armedDownload === 'object' \? armedDownload\.token : armedDownload;/);
  assert.match(source, /const token = armed && typeof armed === 'object' \? armed\.token : armed;/);
});

test("a helper that produces a live object turns its handle into a node", () => {
  /*
   * The second bug. `collectPopup` answers with `{ handle, pageId }`, and only
   * `run()` turns that marker into something a program can call Playwright on.
   * Without this the popup is caught and cannot be driven.
   */
  assert.match(source, /if \(popup && typeof popup === 'object' && typeof popup\.handle === 'number'\)/);
  assert.match(source, /const node = makeNode\(popup\.handle, \[\]\);/);
});

test("the page root is defined once, so a body one frame down can reach it", () => {
  /*
   * The third bug. The roots were built inside the returned object literal, so
   * `download`'s trigger, called from the builder's own scope, saw no `page`
   * binding at all.
   */
  assert.match(source, /const rootPage = makeNode\(__pageRoot\.page, \[\]\);/, "the page root must be a named binding");
  assert.match(source, /const rootBrowser = makeNode\(__pageRoot\.browser, \[\]\);/);
  assert.match(source, /const rootPages = makeNode\(__pageRoot\.pages, \[\]\);/);
  /*
   * And the returned object must reference those bindings rather than building
   * its own, or the two copies drift and a body's `page` is not the program's.
   */
  assert.match(source, /^    page: rootPage,$/m);
  assert.match(source, /^    browser: rootBrowser,$/m);
  assert.match(source, /^    pages: rootPages,$/m);
  assert.doesNotMatch(source, /^    page: makeNode\(__pageRoot\.page, \[\]\),$/m, "the inline copy must be gone");
});

test("a tx body receives the transaction's page, and nothing else", () => {
  /*
   * `browser` and `pages` are injected into the program's scope by the worker
   * and do not exist in the builder's, so passing them to a body threw
   * "browser is not defined". The body resolves them in its own scope, and the
   * transaction's page is the only thing it cannot get for itself.
   */
  assert.match(source, /const value = await body\(\{ page: bodyPage \}\);/);
  assert.doesNotMatch(source, /await body\(\{ page: bodyPage, browser: browser/);
});
