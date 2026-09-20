/**
 * The perception engine, while it is a stub.
 *
 * The custom collector and compiler were deleted and their replacement is being
 * designed, so `perceive` now always returns Playwright's own accessibility
 * snapshot. This file pins the contract the replacement has to meet, so the two
 * things it must not do are checked from the start: go blind, and lie about
 * being a compiled view.
 *
 * The stub is what makes the browser tool work today, so the assertions are
 * about the *shape* staying honest rather than about the content being clever:
 * the text is the page, `usedFallback` says so, and the note tells the model how
 * to address elements. When the compiler returns, `usedFallback` starts being
 * false on a good read and these tests keep passing for the paths that remain.
 *
 * These run without a browser. A page is a stand-in with the one method the
 * engine calls.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { perceive } from "../../../src/browser/engine.js";

/** Just enough of a Page for `perceive`'s `ariaSnapshot` call. */
function fakePage(snapshot: string): { ariaSnapshot: (options?: unknown) => Promise<string>; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    ariaSnapshot: async (options?: unknown) => {
      calls.push(options);
      return snapshot;
    },
  };
}

test("the stub returns Playwright's snapshot and says it is a fallback", async () => {
  const page = fakePage('- button "Continue" [ref=e1]');
  const result = await perceive(page as never);

  assert.equal(result.usedFallback, true, "the stub must not claim to be a compiled view");
  assert.equal(result.fallbackReason, "stub");
  assert.match(result.text, /Continue/, "the model still gets the page");
  assert.equal(result.ir, undefined, "there is no compiled page to hand back");
});

test("the note tells the model how to address elements", async () => {
  /*
   * The load-bearing half of a fallback. The compiled view hands out `s1:r3` and
   * locator expressions; the snapshot hands out `aria-ref=e74`. A model that
   * reads a fallback without knowing it is one writes a locator that resolves to
   * nothing and concludes the page is wrong, which is a worse failure than being
   * told plainly.
   */
  const result = await perceive(fakePage('- button "Continue" [ref=e1]') as never);

  assert.match(result.note ?? "", /SNAPSHOT|FALLBACK/);
  assert.match(result.note ?? "", /aria-ref/, "the addressing mode is named");
});

test("the snapshot is the whole page, with no depth cut", async () => {
  /*
   * The one optimisation that looks free and is not. Measured on Hacker News,
   * `depth: 6` returns 8,729 characters against the full snapshot's 47,683 and
   * keeps every story title, which makes it look like the obvious saving. It is
   * a trap: depth folds controls into their ancestor's accessible name, so the
   * nav links stop carrying their own refs and the page's 225 addressable
   * actions collapse to 8. `login`, `past` and `submit` become unclickable words
   * inside a parent's name, and the model reads a page that looks complete and
   * cannot be acted on.
   */
  const page = fakePage('- link "Home" [ref=e1]');
  await perceive(page as never);

  assert.equal(page.calls.length, 1);
  const options = page.calls[0] as { mode?: string; depth?: unknown };
  assert.equal(options.mode, "ai");
  assert.equal(options.depth, undefined, "no depth: the model needs the controls, not just the text");
});

test("raw mode is labelled differently from the stub fallback", async () => {
  const result = await perceive(fakePage('- link "Home" [ref=e1]') as never, { raw: true });

  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, "requested");
  assert.match(result.note ?? "", /RAW/);
});

test("a page that is gone rejects rather than returning an empty view", async () => {
  /*
   * The one failure that must escape. An empty view reads to a model as a blank
   * page, so the difference between "nothing to say" and "the page is gone" has
   * to survive as a thrown error rather than as a view with nothing in it.
   */
  const gone = {
    ariaSnapshot: async () => {
      throw new Error("Target page, context or browser has been closed");
    },
  };

  await assert.rejects(() => perceive(gone as never), /has been closed/);
});

test("the whole-page read uses the text form, not the JSON one", async () => {
  /*
   * Pinned because switching it shipped once and the failure was invisible.
   *
   * Playwright 1.63 offers the same tree as text or as JSON, and the JSON form
   * is the right one for a *scoped* read (`observe-ladder.ts`), where per-element
   * geometry is what answers "why can I not click this". On the whole-page path
   * it buys nothing and costs twice:
   *
   *   /basic        text 1378 chars, 24 refs  | json 1663 chars, 24 refs
   *   /form-limits  text 1182 chars, 21 refs  | json 1416 chars, 21 refs
   *
   * Same refs, both addressing the same elements through
   * `page.locator("aria-ref=e1")`, and 17 to 20 percent larger as JSON because
   * every key is quoted and every key is repeated. On a real page that is tens of
   * thousands of characters paid on every look.
   *
   * It also silently zeroed the stats. `statsOf` counts `[ref=...]` markers in
   * the text, and the JSON form has none, so every page reported 0 refs and 0
   * interactive elements. That does not read as a bug, it reads as an empty page,
   * which is why it survived review and was caught by an integration test
   * asserting the count.
   */
  const page = fakePage('- button "Continue" [ref=e1]');
  Object.assign(page, {
    ariaSnapshotJSON: async () => { throw new Error("the JSON form must not be used for a whole-page read"); },
  });
  await perceive(page as never);

  assert.equal(page.calls.length, 1, "the text form is the one called");
  assert.match((page as unknown as { calls: Array<{ mode?: string }> }).calls[0]?.mode ?? "", /^ai$/);
});
