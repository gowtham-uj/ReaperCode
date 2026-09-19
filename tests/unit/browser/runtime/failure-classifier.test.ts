/**
 * The classifier, against the messages Playwright actually produces.
 *
 * These strings are copied from real failures rather than invented, because the
 * whole value of the classifier is that it reads the messages a browser emits
 * and not the ones a test author would write. A test against a paraphrase would
 * pass while the classifier failed on the real thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure, renderFailure } from "../../../../src/browser/runtime/failure.js";

/**
 * The shape Playwright uses for a locator that never matched anything.
 *
 * Copied rather than paraphrased, and deliberately without the "resolved to N
 * elements" line: that line is a strict-mode violation, which is a different
 * failure with a different fix, and a fixture that carried it would be testing
 * the ambiguity branch under a name about missing elements.
 */
const notFound = (what: string, ms = 30_000): Error =>
  new Error(`${what}\n\nCall log:\n  - waiting for locator('button')\n  -   Timeout ${ms}ms exceeded.`);

test("an ambiguous locator is named as ambiguous, not as a timeout", () => {
  /*
   * Playwright reports strict mode violations inside a timeout message, so the
   * naive branch would classify this as ACTION_TIMEOUT and the model would go
   * and inspect an element that is fine. The specific check has to come first.
   */
  const failure = classifyFailure(new Error("strict mode violation: locator('a.del') resolved to 3 elements"));
  assert.equal(failure.kind, "LOCATOR_AMBIGUOUS");
  assert.equal(failure.retryable, false);
});

test("a zero-area element is ZERO_AREA when geometry is known and NOT_VISIBLE when it is not", () => {
  const error = new Error("element is not visible");
  assert.equal(classifyFailure(error, { width: 0, height: 40 }).kind, "ZERO_AREA");
  assert.equal(classifyFailure(error).kind, "NOT_VISIBLE");
});

test("a covered element is retryable, because the obstruction is often transient", () => {
  const failure = classifyFailure(new Error("<div class=modal>…</div> intercepts pointer events"));
  assert.equal(failure.kind, "NOT_RECEIVING_EVENTS");
  assert.equal(failure.retryable, true);
});

test("a missing element is never retryable", () => {
  const failure = classifyFailure(notFound("locator.click: Timeout 30000ms exceeded"));
  assert.equal(failure.kind, "LOCATOR_NOT_FOUND");
  assert.equal(failure.retryable, false);
  assert.match(failure.diagnostic, /matched nothing/);
});

test("a closed page is recognised before the timeout branches, which also match it", () => {
  const failure = classifyFailure(new Error("Target page, context or browser has been closed"));
  assert.equal(failure.kind, "PAGE_CLOSED");
  assert.equal(failure.retryable, false);
});

test("a detached element is the one plain retry that is worth making", () => {
  const failure = classifyFailure(new Error("Element is not attached to the DOM"));
  assert.equal(failure.kind, "DETACHED");
  assert.equal(failure.retryable, true);
});

test("the rendered failure is small, and names a next action", () => {
  const failure = classifyFailure(notFound("locator.fill: Timeout 30000ms exceeded"));
  const text = renderFailure(failure);
  /*
   * The failure this replaces was Playwright's call log, a dozen lines the model
   * had to decode. The rendered packet has one line per fact and no call log.
   */
  assert.ok(text.split("\n").length <= 6, `too long:\n${text}`);
  assert.match(text, /^FAILURE: /);
  assert.match(text, /NEXT: /);
  assert.doesNotMatch(text, /Call log/);
});
