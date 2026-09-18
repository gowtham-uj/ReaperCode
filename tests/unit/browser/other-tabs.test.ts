/**
 * A step that acts on a tab other than the active one.
 *
 * This is the failure that cost a mission twenty tool calls. The program found a
 * tab by URL and drove it:
 *
 *     const ti = pages.find(p => p.url().includes("the-internet"));
 *     await ti.goto("/login");
 *
 * and the receipt was rendered from the ACTIVE page, a different tab that had not
 * moved. So it said "the page did not change", the model concluded its click had
 * done nothing, and it spent twenty calls investigating a click that had worked
 * perfectly on a page it was never looking at.
 *
 * The runtime now compares every page it owns before and after the step, names
 * the ones that moved, and points the follow-up read at the tab that changed.
 * These tests pin the receipt shapes that make that visible, without a browser:
 * the receipt fields and the note are plain data by the time the tool sees them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReceipt, type StepReceipt } from "../../../src/browser/transaction.js";

function receipt(overrides: Partial<StepReceipt> = {}): StepReceipt {
  return {
    outcome: "NO_CHANGE",
    revision: 4,
    after: 5,
    navigated: false,
    urlBefore: "https://webdriveruniversity.com/To-Do-List/index.html",
    urlAfter: "https://webdriveruniversity.com/To-Do-List/index.html",
    changes: "(no change)",
    wholesale: false,
    elapsedMs: 120,
    note: "The action ran and the page did not change.",
    ...overrides,
  };
}

test("a step that moved another tab says so in its note", () => {
  const text = renderReceipt(receipt({
    note:
      "The action ran and the page did not change. " +
      "Other tabs this thread owns changed during the step even though this one did not: " +
      "the-internet (https://the-internet.herokuapp.com/ -> https://the-internet.herokuapp.com/login). " +
      "The program acted through a page handle rather than the active page.",
    otherTabsMoved: true,
  }));
  assert.match(text, /Other tabs this thread owns changed/);
  assert.match(text, /the-internet \(https:\/\/the-internet\.herokuapp\.com\/ -> https:\/\/the-internet\.herokuapp\.com\/login\)/);
});

test("the flag is what tells a dead step from a step on another tab", () => {
  /*
   * The two states used to be the same receipt. `NO_CHANGE` with no movement
   * anywhere means the action really did nothing, and only then is the circuit
   * breaker's advice worth giving: pointing a model at `recover()` for a page
   * that was working would send it to fix the wrong thing.
   */
  const dead = receipt();
  const elsewhere = receipt({ otherTabsMoved: true });
  assert.equal(dead.outcome, "NO_CHANGE");
  assert.equal(elsewhere.outcome, "NO_CHANGE");
  assert.equal(dead.otherTabsMoved, undefined, "nothing moved anywhere: a genuinely dead action");
  assert.equal(elsewhere.otherTabsMoved, true, "something moved, just not on this page");
});

test("the ordinary receipt is unchanged when nothing moved", () => {
  // Every step that does not touch another tab must be byte-identical in shape,
  // or the note becomes noise the model learns to skip.
  const text = renderReceipt(receipt());
  assert.doesNotMatch(text, /Other tabs/);
  assert.equal(receipt().otherTabsMoved, undefined, "absent, not false: nothing was observed to move");
});
