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
import { readFile } from "node:fs/promises";

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

test("the runtime's own refusals are classified, not reported as UNKNOWN", () => {
  /*
   * Measured on a mission: ten receipts said `FAILURE: UNKNOWN / next: Look at
   * the page and try a different approach` for errors whose own messages were
   * exact. The classifier handled Playwright's errors and fell through on this
   * codebase's, which threw away the one sentence that named the cause.
   *
   * Each of these is a real message from a real run.
   */
  const notFound = classifyFailure(new Error('no open page named "p8". Open pages: p15 "github", p20 "playwright-docs"'));
  assert.equal(notFound.kind, "PAGE_NOT_FOUND");
  assert.equal(notFound.retryable, false);
  assert.match(notFound.recommendedNext ?? "", /browser\.pages\(\)|name or id/);

  const arg = classifyFailure(new Error('subtask status must be one of pending, running, blocked, done, verified, failed, got "dome"'));
  assert.equal(arg.kind, "INVALID_ARGUMENT");
  assert.equal(arg.retryable, false);

  const awaitTrap = classifyFailure(
    new Error("`find` with an async callback returns a Promise, so its result needs `await`"),
  );
  assert.equal(awaitTrap.kind, "MISSING_AWAIT");
  assert.match(awaitTrap.recommendedNext ?? "", /await/);
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

test("a form the browser refused is FORM_VALIDATION, not UNKNOWN", () => {
  /*
   * `FORM_VALIDATION` and `SERVER_REJECTION` were declared in the taxonomy, held
   * in the recovery policy, and produced by nothing, so both arrived as UNKNOWN.
   * A form the browser refused is the ordinary way a signup fails, and the two
   * want opposite responses: a browser refusal has a readable reason the page can
   * be asked for, a server refusal has no client-visible cause at all.
   */
  const browserRefusal = classifyFailure(new Error("Please fill out this field."));
  assert.equal(browserRefusal.kind, "FORM_VALIDATION", JSON.stringify(browserRefusal));
  assert.match(browserRefusal.recommendedNext ?? "", /inspectForm/, "and the model is told how to read the constraint");
});

test("a value the server refused after a clean form is SERVER_REJECTION", () => {
  const taken = classifyFailure(new Error("That username is already taken."));
  assert.equal(taken.kind, "SERVER_REJECTION", JSON.stringify(taken));
  assert.equal(taken.retryable, true, "a different value is worth trying");
  assert.match(taken.recommendedNext ?? "", /inspectForm/, "and the guidance names a call the model can actually make");
});

test("an ordinary error is not misread as a form refusal", () => {
  /*
   * The classifier runs before Playwright's own kinds, so a branch that is too
   * broad would mislabel unrelated failures. "valid" appears in plenty of
   * unrelated sentences, which is why the match is on the browser's own phrasing.
   */
  assert.equal(classifyFailure(new Error("Target page, context or browser has been closed")).kind, "PAGE_CLOSED");
  const timeout = classifyFailure(new Error("locator.click: Timeout 30000ms exceeded."));
  assert.notEqual(timeout.kind, "FORM_VALIDATION");
  assert.notEqual(timeout.kind, "SERVER_REJECTION");
});

test("a popup that never opened is POPUP_NOT_CREATED, not UNKNOWN", () => {
  /*
   * The runtime writes this sentence itself, and it matched no branch, so it
   * arrived as UNKNOWN with the advice "look at the page and try a different
   * approach". That is the wrong next step for a link that never opened a tab.
   */
  const r = classifyFailure(new Error(
    "the trigger ran but no new page opened. If the link opens in the same tab, use page.goto() or click it directly; if the site fetches the page by script, it is not a popup.",
  ));
  assert.equal(r.kind, "POPUP_NOT_CREATED", JSON.stringify(r));
  assert.equal(r.retryable, false, "a second identical click does not make a popup appear");
  assert.match(r.recommendedNext ?? "", /opens in place|goto/i, "and the advice fits the cause");
});

test("a renderer that stopped delivering events is RENDERER_UNRESPONSIVE", () => {
  const r = classifyFailure(new Error(
    "the page did NOT receive the probe click, so its renderer has stopped accepting input. Clicks and typing will keep doing nothing on this page. Call recover(target) to replace the renderer, then retry.",
  ));
  assert.equal(r.kind, "RENDERER_UNRESPONSIVE", JSON.stringify(r));
  assert.match(r.diagnostic, /events|input/i, "the mechanism is named");
  assert.equal(r.retryable, true, "replacing the renderer is what fixes it, so the step is worth repeating after");
});

test("a probe that could not run is not misread as an unresponsive renderer", () => {
  /*
   * `probeInput` answers two different things with one shape: the click did not
   * land, or the probe itself threw. Only the first means the renderer is broken,
   * and replacing a renderer because a probe errored would lose the session for
   * nothing.
   */
  const r = classifyFailure(new Error("the probe could not run: Target page, context or browser has been closed"));
  assert.notEqual(r.kind, "RENDERER_UNRESPONSIVE");
});

test("a download whose artifact the browser removed is flagged for repair", () => {
  /*
   * The shared-browser failure, measured: Steel is one browser for every client,
   * and another Playwright client attaching and disconnecting leaves the browser
   * pointing at an artifact directory that client deleted. Every download after
   * it fails with ENOENT on a path that no longer exists, which a fresh
   * connection repairs and `setDownloadBehavior` does not.
   *
   * The flag exists so the tool can act on it without matching prose written for
   * a model, and so a genuinely empty or cancelled download is not repaired.
   */
  const lost = classifyFailure(new Error(
    "the browser downloaded \"invoice.txt\" but it could not be copied into this thread's vault. " +
    "download.saveAs: ENOENT: no such file or directory, copyfile '/tmp/playwright-artifacts-x/a' -> '/vault/invoice.txt'.",
  ));
  assert.equal(lost.kind, "DOWNLOAD_FAILED");
  assert.equal(lost.artifactLost, true, "an artifact error is what the connection refresh answers");
  assert.equal(lost.retryable, true);
});

test("a download that never produced a file is not flagged for repair", () => {
  /*
   * The distinction that matters: "no download arrived" is not a connection
   * problem, and refreshing the connection for it would drop every handle for a
   * step that was going to fail anyway.
   */
  const never = classifyFailure(new Error("the trigger ran but no download arrived."));
  assert.equal(never.artifactLost, undefined, "nothing to repair when nothing downloaded");
});

test("the receipt carries artifactLost through to the tool", async () => {
  /*
   * The bug this pins, and it is the same shape as the others in this area: the
   * classifier set the flag, and the receipt rebuilt the failure field by field
   * from a hand-written list, so the tool saw `undefined` and never repaired
   * anything. A field added to `BrowserFailure` and not to that list is invisible
   * in exactly the way a method with no caller is.
   *
   * Checked in the source because the receipt is built inside `step`, which needs
   * a live page. What can be asserted without one is the thing that broke: the
   * receipt's failure object names every field of the classifier's.
   */
  const source = await readFile(new URL("../../../../src/browser/transaction.ts", import.meta.url), "utf8");
  const at = source.indexOf("failure: {");
  assert.ok(at !== -1, "the receipt builds its failure here");
  const block = source.slice(at, at + 700);
  for (const field of ["kind", "diagnostic", "retryable", "artifactLost"]) {
    assert.match(block, new RegExp(field), `the receipt must carry \`${field}\`, or the classifier is writing to nothing`);
  }
});
