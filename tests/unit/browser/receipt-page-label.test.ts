/**
 * Naming the page a receipt is about.
 *
 * Mid-mission, thirteen consecutive receipts read `URL: about:blank` while the
 * programs were filling a form on a named tab: the receipt is rendered from the
 * page the step captured, and the model was reading a different tab's URL. The
 * label exists so a receipt says which page it describes when that is not the
 * one the model is looking at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReceipt, type StepReceipt } from "../../../src/browser/transaction.js";

function receipt(overrides: Partial<StepReceipt> = {}): StepReceipt {
  return {
    outcome: "SUCCESS",
    revision: 3,
    after: 4,
    navigated: false,
    urlBefore: "about:blank",
    urlAfter: "about:blank",
    changes: "changed",
    wholesale: false,
    elapsedMs: 12,
    note: "The page changed without navigating.",
    ...overrides,
  };
}

test("a labelled receipt names the page it is about", () => {
  const text = renderReceipt(receipt({ pageLabel: "parabank (https://parabank.parasoft.com/parabank/index.htm)" }));
  assert.match(text, /^PAGE: parabank \(https:\/\/parabank\.parasoft\.com/m, "the page is named");
  // Before the change lines, so what the receipt is about is read first.
  assert.ok(text.indexOf("PAGE:") < text.indexOf("changed"), "the label precedes the description");
});

test("an ordinary receipt carries no page line", () => {
  // The active page is where the model is already looking, so naming it on every
  // step would be noise in every tool result.
  const text = renderReceipt(receipt());
  assert.doesNotMatch(text, /^PAGE:/m, "no page line when the receipt is about the active page");
});

test("the other receipt fields are unchanged by the label", () => {
  const text = renderReceipt(receipt({ pageLabel: "cart (https://shop.example/cart)" }));
  assert.match(text, /^OUTCOME: SUCCESS$/m);
  assert.match(text, /^REV 3 -> 4$/m);
  assert.match(text, /^elapsed 12ms$/m);
  assert.match(text, /^changed$/m);
});
