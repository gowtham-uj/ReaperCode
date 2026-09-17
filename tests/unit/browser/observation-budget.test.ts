/**
 * How much page a step is allowed to return.
 *
 * The mission's token bill was dominated by this: a program that answered its own
 * question still got the whole accessibility tree appended, and because a tool
 * result enters the conversation it was re-sent with every later call. Measured
 * from the transcript, one page's output ran to 262,631 characters and the model
 * paid for it many times over.
 *
 * These tests pin the two rules that bound it: a self-answering program gets no
 * page, and the fallback tree is capped with a notice that says how to see more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PageObserver, VIEW_FALLBACK_MAX_CHARS, VIEW_MAX_CHARS, trimOutline } from "../../../src/browser/page-view.js";

test("the fallback tree is bounded, and the bound is generous but real", () => {
  // The old behaviour was unbounded, on the argument that a fallback has no
  // named sections to open later. True, and outweighed by being re-billed on
  // every following call.
  assert.ok(VIEW_FALLBACK_MAX_CHARS > VIEW_MAX_CHARS, "a fallback is a page, so its budget is larger than a summary's");
  assert.ok(VIEW_FALLBACK_MAX_CHARS <= 50_000, "but it is still a bound");

  const huge = Array.from({ length: 5_000 }, (_, i) => `  - link "Item ${i}" [ref=e${i}]`).join("\n");
  const trimmed = trimOutline(huge, VIEW_FALLBACK_MAX_CHARS);
  assert.equal(trimmed.truncated, true, "an oversized tree is cut");
  assert.ok(trimmed.outline.length < VIEW_FALLBACK_MAX_CHARS + 400, "and the result is inside the budget");
});

test("a cut says how to see the rest", () => {
  // A cut that does not say how to undo it is a dead end, and the whole
  // justification for bounding the fallback was that the rest is reachable.
  const huge = Array.from({ length: 5_000 }, (_, i) => `  - link "Item ${i}"`).join("\n");
  const { outline } = trimOutline(huge, 1_000);
  assert.match(outline, /more lines not shown/);
  assert.match(outline, /view\(\{ selector \}\)/, "names the region read");
  assert.match(outline, /view\(\{ depth \}\)/, "names the deeper read");
  assert.match(outline, /observe: "full"/, "names the whole-page read");
});

test("an untrimmed capture is delivered as it stands", () => {
  const small = "- heading \"Hi\" [ref=e1]";
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: small, untrimmed: true });
  assert.equal(observer.wasTruncated(), false);
  assert.match(observer.view().text, /heading "Hi"/);
});

test("an untrimmed capture larger than the fallback budget is still cut", () => {
  /*
   * The regression this exists for: `untrimmed: true` used to mean "no bound at
   * all", which is how a page produced 262,631 characters of output. It now
   * means "the page budget rather than the summary budget", which is a bound.
   */
  const huge = Array.from({ length: 20_000 }, (_, i) => `  - link "Item number ${i}" [ref=e${i}]`).join("\n");
  assert.ok(huge.length > VIEW_FALLBACK_MAX_CHARS * 3, "the fixture is bigger than the budget");
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: huge, untrimmed: true });
  assert.equal(observer.wasTruncated(), true, "an untrimmed capture is still bounded");
  assert.ok(observer.view().text.length < VIEW_FALLBACK_MAX_CHARS + 500);
});

test("a small page is not marked truncated and carries no cut notice", () => {
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: "- button \"Go\"" });
  const view = observer.view();
  assert.equal(view.truncated, false);
  assert.doesNotMatch(view.text, /not shown/);
});
