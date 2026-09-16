/**
 * The verifier, levels 0 and 1.
 *
 * The receipt answers "what changed". The verifier answers "was that the thing
 * that was wanted", and the two come apart in ways that cost a whole task: a
 * click that submitted a form the server rejected changed the page, so every
 * structural check passes and the model moves on from a failure.
 *
 * These cover the free checks, which is the whole of what ships. Levels 2 and 3
 * are a model call and a reward model, and neither is built.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { verifyStep } from "../../../src/browser/verify.js";
import type { StepReceipt } from "../../../src/browser/transaction.js";

/** A receipt for a step that changed the page, which is the common case. */
function receipt(over: Partial<StepReceipt> = {}): StepReceipt {
  return {
    outcome: "SUCCESS",
    revision: 1,
    after: 2,
    navigated: false,
    urlBefore: "https://x/a",
    urlAfter: "https://x/a",
    changes: "Added: something",
    wholesale: false,
    elapsedMs: 10,
    note: "",
    ...over,
  };
}

test("nothing to check means nothing is claimed", () => {
  // The report must not say "passed" in a way a caller could read as "verified".
  const report = verifyStep(receipt(), undefined, '- heading "Jobs"');
  assert.equal(report.passed, true);
  assert.match(report.summary, /nothing contradicted it/);
  assert.equal(report.checks.length, 0);
});

test("an expectation that holds passes", () => {
  const report = verifyStep(receipt({ urlAfter: "https://x/dashboard" }), { urlIncludes: "/dashboard" }, "");
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 1);
  assert.match(report.summary, /1 check passed/);
});

test("an expectation that does not hold names the actual state", () => {
  /*
   * The message has to carry what the page actually is. "The check failed"
   * leaves a model guessing; "the url is https://x/a, which does not contain
   * /dashboard" tells it the click did not navigate.
   */
  const report = verifyStep(receipt({ urlAfter: "https://x/a" }), { urlIncludes: "/dashboard" }, "");
  assert.equal(report.passed, false);
  assert.match(report.summary, /https:\/\/x\/a/, "the actual url must be in the message");
  assert.match(report.summary, /\/dashboard/);
});

test("a step that was expected to change the page and did not is a failure", () => {
  const report = verifyStep(receipt({ outcome: "NO_CHANGE" }), { pageChanged: true }, "");
  assert.equal(report.passed, false);
  assert.match(report.summary, /did not change/);
});

test("text that should have appeared and did not is a failure", () => {
  const report = verifyStep(receipt(), { textPresent: "Application submitted" }, '- heading "Form"');
  assert.equal(report.passed, false);
  assert.match(report.summary, /Application submitted/);
});

test("text that should be gone and is not is a failure", () => {
  const report = verifyStep(receipt(), { textAbsent: "Sign in" }, '- button "Sign in"');
  assert.equal(report.passed, false);
  assert.match(report.summary, /still on the page/);
});

test("an error on the page is reported even when the step succeeded", () => {
  /*
   * The case level 0 exists for and the one a receipt cannot see. The click
   * worked, the page re-rendered, and the server rejected the submission. A
   * model told only SUCCESS moves on.
   */
  const report = verifyStep(receipt(), undefined, '- alert "Email is required"\n- button "Continue"');
  assert.equal(report.passed, false);
  assert.match(report.summary, /Email is required/);
  assert.match(report.summary, /rejected/);
});

test("an expected error is not reported as a surprise", () => {
  // Submitting a form to see the validation message is a legitimate step.
  const report = verifyStep(receipt(), { expectFailure: true }, '- alert "Email is required"');
  assert.equal(report.passed, true);
});

test("an expected error that never appears is a failure", () => {
  const report = verifyStep(receipt(), { expectFailure: true }, '- heading "Dashboard"');
  assert.equal(report.passed, false);
  assert.match(report.summary, /an error was expected/);
});

test("a marked role is preferred over a stray word", () => {
  /*
   * "error" appears inside plenty of ordinary text, and reporting a page for
   * containing the word would make the check useless. An element whose role says
   * alert or status is the page actually announcing something.
   */
  const report = verifyStep(receipt(), undefined, '- paragraph "Read the error handling guide"');
  assert.equal(report.passed, true, "prose containing 'error' is not a failure");
});

test("several failed checks are all named", () => {
  // A model fixing one thing at a time needs the whole list, not the first.
  const report = verifyStep(receipt({ urlAfter: "https://x/a" }), { urlIncludes: "/dashboard", textPresent: "Welcome" }, "");
  assert.equal(report.passed, false);
  assert.match(report.summary, /2 of 2 checks failed/);
  assert.match(report.summary, /\/dashboard/);
  assert.match(report.summary, /Welcome/);
});
