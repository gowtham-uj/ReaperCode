/**
 * The `view({ selector })` spelling, which the cut notice tells the model to use
 * and which did nothing.
 *
 * When a view is trimmed, the notice names its remedies: `view({ selector })` for
 * one region, `view({ depth })` for more levels, `observe: "full"` for the whole
 * page. All three are advice the model is expected to act on. The sandbox
 * forwards a program's arguments verbatim, so `view({ selector: "main" })`
 * arrived at the host as a plain object, the wrapper turned it into
 * `{ page: { selector: "main" } }`, nothing recognised the "page", and the read
 * fell back to the whole page. A program following the tool's own message paid
 * for the full page and had no way to tell it had been ignored.
 *
 * This is a pure function over the argument shape, so it is tested as one. Which
 * of the three shapes a program meant is decided by what the value has, not by
 * where it came from, and the discrimination is what these assertions pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isLocator, viewOptionsOf } from "../../../../src/browser/thread-runtime.js";

/** A locator stand-in: snapshots itself, cannot navigate. */
const fakeLocator = { ariaSnapshot: async () => "- fake", toString: () => 'locator("main")' };
/** A page stand-in: navigates. */
const fakePage = { ariaSnapshot: async () => "- page", goto: async () => undefined, url: () => "about:blank" };

test("an options object becomes options, not a page", () => {
  /*
   * The bug, exactly. Before this, `{ selector: "main" }` was read as a target
   * and `options.page` became the object itself, so the whole-page branch ran.
   */
  assert.deepEqual(viewOptionsOf({ selector: "main" }), { selector: "main" });
  assert.deepEqual(viewOptionsOf({ depth: 4 }), { depth: 4 });
  assert.deepEqual(viewOptionsOf({ selector: "form", depth: 3, maxChars: 800 }), {
    selector: "form",
    depth: 3,
    maxChars: 800,
  });
});

test("a locator is a target to read, not a bag of options", () => {
  /*
   * Both a Page and a Locator have `ariaSnapshot`, so the discriminator is the
   * method rather than a class check, which is the same test the runtime uses to
   * tell the two apart elsewhere.
   */
  const options = viewOptionsOf(fakeLocator);
  assert.equal(options.page, fakeLocator, "the locator must be the page to read");
  assert.equal(options.selector, undefined, "and must not be mistaken for an options object");
});

test("a page is a target to read, the same way", () => {
  assert.equal(viewOptionsOf(fakePage).page, fakePage);
});

test("an absent or unusable argument reads the active page", () => {
  /* `view()` with nothing falls back to the active page, which is the default. */
  assert.deepEqual(viewOptionsOf(undefined), {});
  assert.deepEqual(viewOptionsOf(null), {});
  assert.deepEqual(viewOptionsOf("main"), {}, "a bare string is not an options object here");
  assert.deepEqual(viewOptionsOf(42), {});
});

test("an object spanning both shapes is treated as a target", () => {
  /*
   * A Playwright object with a `selector` property of its own must not be
   * re-read as options: the method is the stronger signal, and mistaking a page
   * for options silently reads the wrong thing. Pinned because it is the
   * ambiguous case, even though no real Playwright object carries `selector`.
   */
  const pageish = { ariaSnapshot: async () => "- x", selector: "not-a-real-field" };
  assert.equal(viewOptionsOf(pageish).page, pageish);
});

test("isLocator still tells a locator from a page, since the routing depends on it", () => {
  assert.equal(isLocator(fakeLocator), true);
  assert.equal(isLocator(fakePage), false);
  assert.equal(isLocator({}), false);
  assert.equal(isLocator(undefined), false);
});
