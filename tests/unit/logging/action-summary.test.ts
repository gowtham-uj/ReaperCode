/**
 * What the agent did, in a sentence, for the session log.
 *
 * A log that says `## tool browser_use t3 1200ms` tells a reader nothing about
 * the browsing it recorded. These cover the line that replaces it, and the
 * property that matters most: a tool this does not understand returns undefined
 * rather than inventing a sentence for it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { summariseBrowserAction } from "../../../src/logging/action-summary.js";

test("a successful step names the page it happened on", () => {
  const line = summariseBrowserAction("browser_use", {
    outcome: "SUCCESS",
    surface: { url: "https://jobs.example.com/j/1", title: "AI Engineer" },
  });
  assert.match(line ?? "", /https:\/\/jobs\.example\.com\/j\/1/);
  assert.match(line ?? "", /AI Engineer/);
});

test("a step that changed nothing says so, which is the whole reason the outcome exists", () => {
  /*
   * The one a reader most needs phrased. A click that achieved nothing is
   * visible in the log as a click; the sentence is what says whether that was
   * expected.
   */
  const line = summariseBrowserAction("browser_use", { outcome: "NO_CHANGE", surface: { url: "https://x" } });
  assert.match(line ?? "", /did not change/);
});

test("every outcome has a sentence, and none of them is a bare enum", () => {
  // A missing case would silently fall to the default and read as success.
  const outcomes = [
    "SUCCESS",
    "NO_CHANGE",
    "STALE_REVISION",
    "PRECONDITION_FAILED",
    "POSTCONDITION_FAILED",
    "TIMEOUT",
    "BROWSER_DISCONNECTED",
    "PARTIAL_COVERAGE",
  ];
  for (const outcome of outcomes) {
    const line = summariseBrowserAction("browser_use", { outcome, surface: { url: "https://x" } });
    assert.ok(line !== undefined && line.length > 10, `${outcome} must have a sentence`);
    assert.doesNotMatch(line ?? "", /_/, `${outcome} must be phrased in words, not as the enum`);
  }
});

test("a tool this does not understand gets no sentence", () => {
  // Returning a line for `bash` would put a misleading sentence in the log.
  assert.equal(summariseBrowserAction("bash", { outcome: "SUCCESS" }), undefined);
  assert.equal(summariseBrowserAction("browser_use", null), undefined);
  assert.equal(summariseBrowserAction("browser_use", { no_outcome: true }), undefined);
});

test("a step with no url still produces a readable line", () => {
  // The disconnected case has no page to name, and must not read as a gap.
  const line = summariseBrowserAction("browser_use", { outcome: "BROWSER_DISCONNECTED" });
  assert.match(line ?? "", /browser went away/);
  assert.doesNotMatch(line ?? "", /\bon\s*$/, "a dangling preposition reads as a truncation");
});
