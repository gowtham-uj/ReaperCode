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

test("a locator function argument is carried as a real function, not a string", async () => {
  /*
   * `locator.evaluate((el) => ...)` never receives the element through this
   * bridge, and the model lost a step to it on a live run:
   *
   *   locator.evaluate: TypeError: Cannot read properties of undefined
   *   (reading 'textContent')
   *
   * Measured against the live browser with no bridge involved, no string can
   * reach it: a bare arrow is evaluated as an expression and never called, and
   * the invoke wrapper calls it with no arguments. Only a real function works,
   * which is what `carrySource` builds: a function whose body throws and whose
   * `toString` is the source, so Playwright serialises the source and compiles it
   * in the browser while the host compiles nothing.
   *
   * Checked in the source because observing this needs a live page. The two
   * properties that matter are the ones asserted: the element-passing methods get
   * a carrier, and the carrier is not built by assembling code.
   */
  const source = await readFile(new URL("../../../src/browser/remote-page.ts", import.meta.url), "utf8");
  assert.match(source, /carrySource\(marker\.source\)/, "an element-passing call must get a real function");
  assert.match(source, /Object\.defineProperty\(carrier, "toString"/, "carried by a toString override, which compiles nothing");
  /*
   * Asserted against the code, not the prose: the comment above explains why
   * `new Function` was rejected and naming it there is the point of the comment.
   * A check on the whole file matches its own explanation, which is a test failing
   * for the right reason about the wrong thing.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /new Function\(/, "and must not assemble code: a source can close the wrapper and run on the host");

  /*
   * And `page.evaluate` keeps the string form, which works there. Sending it a
   * carrier would change the path with the longest history in this bridge for no
   * gain, so the discriminator is asserted too.
   */
  /*
   * The discriminator is positive, not negative, and a test caught why: asking
   * "does it lack goto" is true of every stub and every non-page object, which
   * sent `page.evaluate` a carrier and broke three tests about the string form.
   * Requiring a Locator-only method says what the object is.
   */
  assert.match(source, /looksLikeLocator/, "locator-ness is decided by a positive test");
  assert.match(source, /typeof target\["count"\] === "function"/, "a Locator has count");
});
