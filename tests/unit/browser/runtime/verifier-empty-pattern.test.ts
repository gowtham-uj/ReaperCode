/**
 * A requirement with nothing to check is not a requirement.
 *
 * The verifier's whole claim is that it reads evidence rather than the model's
 * word. It had a hole that inverted that: `matchPattern` is a substring test, so
 * `pattern: ""` matched every string, and a run that did nothing answered
 * `finish: [{kind:"url", pattern:""}]` with `VERIFIED: all 1 requirements are
 * met.` on `about:blank`. The same held for `text` with an empty value and
 * `artifact` with an empty name.
 *
 * The lesson is about the shape rather than the character: a check that cannot
 * fail is not a weak check, it is the absence of one wearing the uniform of a
 * passing test. These assertions pin all three, so the hole cannot be reopened
 * by adding a fourth kind that forgets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RunLedger } from "../../../../src/browser/runtime/run-ledger.js";
import { checkRequirement, verify, type Requirement } from "../../../../src/browser/runtime/verifier.js";

function input(overrides: Partial<Parameters<typeof verify>[1]> = {}) {
  return {
    ledger: new RunLedger(),
    url: "about:blank",
    outline: "a page that says nothing in particular",
    facts: new Map<string, string>(),
    verifiedSubtasks: new Set<string>(),
    ...overrides,
  };
}

test("an empty url pattern fails rather than matching about:blank", () => {
  const requirement: Requirement = { kind: "url", pattern: "" };
  const result = checkRequirement(requirement, input());
  assert.equal(result.passed, false, "an empty pattern matches everything, which is the same as checking nothing");
  assert.match(result.detail, /no URL pattern/);
});

test("a whitespace-only url pattern fails the same way", () => {
  /* `" "` is not empty and would have passed `.includes` on a url with a space. */
  const result = checkRequirement({ kind: "url", pattern: "   " }, input());
  assert.equal(result.passed, false);
});

test("an empty text requirement fails rather than passing on any page", () => {
  const result = checkRequirement({ kind: "text", value: "" }, input());
  assert.equal(result.passed, false);
  assert.match(result.detail, /no text to look for/);
});

test("an empty artifact requirement fails rather than matching the first file", () => {
  const result = checkRequirement({ kind: "artifact", name: "" }, input());
  assert.equal(result.passed, false);
  assert.match(result.detail, /names no file/);
});

test("the whole verification refuses a mission whose only requirement is empty", () => {
  /*
   * The end-to-end shape of the bug, so the fix is proven at the level the model
   * experiences it rather than only at the checker.
   */
  const outcome = verify([{ kind: "url", pattern: "" }], input());
  assert.equal(outcome.passed, false, "a run that did nothing must not verify");
  assert.equal(outcome.missing.length, 1);
});

test("a real requirement still passes, so the guard is not a blanket refusal", () => {
  const outcome = verify([{ kind: "url", pattern: "example.com" }], input({ url: "https://example.com/x" }));
  assert.equal(outcome.passed, true);
});
