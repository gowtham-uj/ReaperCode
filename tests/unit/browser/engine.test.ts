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

test("a page that is gone is reported, not thrown, and never comes back empty", async () => {
  /*
   * This asserted a throw, and the throw is what deadlocked a live mission.
   *
   * The intent was right and is kept: an empty view reads to a model as a blank
   * page, so "nothing to say" and "the page is gone" must not look alike. What
   * changed is the mechanism. Throwing escaped the tool, and because the tool's
   * look path has no try, no program ran, so the active page never changed, so
   * every later call hit the same page and the model had no way out.
   *
   * The distinction survives as text instead: a result that says the page could
   * not be read, names why, and states that code still runs. Asserted here as the
   * two properties that matter, so a future change cannot quietly turn this back
   * into either a throw or an empty page.
   */
  const gone = {
    ariaSnapshot: async () => {
      throw new Error("Target page, context or browser has been closed");
    },
    evaluate: async () => { throw new Error("Target page, context or browser has been closed"); },
  };

  const result = await perceive(gone as never);
  assert.match(result.text, /PAGE UNREADABLE/, "the model must be told, not handed a silent empty view");
  assert.ok(result.text.trim().length > 30, "and told enough to act on");
  assert.match(result.note ?? "", /could not be read/, "with the note naming it too");
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

test("a page that cannot be snapshotted returns a readable result instead of throwing", async () => {
  /*
   * The deadlock this pins, measured on a live run: a page stuck in
   * `readyState: "loading"` with no `<body>` (a response that stalled mid-stream)
   * makes `ariaSnapshot` wait for a tree that will never exist. Every mode and
   * every timeout hung, while `title()`, `evaluate()` and `locator()` all answered
   * in milliseconds.
   *
   * Because `perceive` threw and the tool's look path had no try around it, the
   * hang escaped the tool, so no program ran, so the active page never changed,
   * so every later call hit the same page. The model was trapped for seventy calls
   * and ~50 minutes, and its own transcript shows it working out correctly that
   * the only repair was code it could never run.
   *
   * The file's own contract already said "nothing throws for a reason the page
   * caused". This asserts it for the snapshot.
   */
  const wedged = {
    ariaSnapshot: async () => { throw new Error("page.ariaSnapshot: Timeout 15000ms exceeded."); },
    evaluate: async () => ({ readyState: "loading", hasBody: false }),
  };
  const result = await perceive(wedged as never);

  assert.equal(result.usedFallback, true);
  assert.match(result.text, /PAGE UNREADABLE/, "the model is told the page could not be read");
  assert.match(result.text, /still loading/, "and why, read from the page without the accessibility tree");
  assert.match(result.text, /page\.reload\(\)/, "with something it can do about it");
  assert.doesNotMatch(result.text, /^\s*$/, "a failing read must never come back empty, which reads as a blank page");
});

test("the whole-page read is bounded, so a wedged page costs seconds not thirty", async () => {
  /*
   * The context default is 30s and the model paid it on every call while trapped.
   * The bound is passed explicitly so a page that will never answer costs fifteen
   * seconds per look rather than half a minute.
   */
  const calls: Array<{ timeout?: number }> = [];
  const page = {
    ariaSnapshot: async (options?: { timeout?: number }) => { calls.push(options ?? {}); return "- text"; },
    evaluate: async () => ({ readyState: "complete", hasBody: true }),
  };
  await perceive(page as never);

  assert.equal(calls.length, 1);
  assert.ok((calls[0]!.timeout ?? 0) > 0, "an explicit timeout, or the context default applies");
  assert.ok((calls[0]!.timeout ?? 0) <= 20_000, `bounded well below the 30s default, got ${calls[0]!.timeout}`);
});
