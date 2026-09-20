/**
 * What the healer can and cannot say about a locator that failed.
 *
 * It was built with a cache keyed on intent, and the intent it could actually
 * derive is the *ask* rather than the resolved role and name, because at recall
 * time the locator is the thing that stopped resolving. So it cannot hand back a
 * better expression for the same intent, and pretending otherwise would have been
 * a call that returned the model's own input.
 *
 * What it can say is which of two situations the step is in, and that is the
 * question a failed step raises: `live` means the target still resolves and was
 * never the problem, `stale` means it worked here before and does not now. Both
 * are facts the model cannot get without spending a step, which is what makes
 * them worth printing.
 *
 * The healer is also the reason this file exists at all: it was instantiated in
 * the kit and called by nothing, so the repair path was written, correct, and
 * unreachable. These tests pin the behaviour; the call sites are pinned by the
 * tool's own output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { intentOfExpression, LocatorHealer } from "../../../../src/browser/runtime/locator-healer.js";

/**
 * A page whose one locator resolves to an element that is, or is not, actionable.
 *
 * `count()` is the part that matters and the part easiest to forget: `inspectLocator`
 * refuses anything that does not resolve to exactly one element, so a fixture
 * without it reports zero matches and every inspection reads as non-actionable,
 * which silently turns every `live` into a `stale`.
 */
function fakePage(actionable: boolean): never {
  return {
    locator: () => ({
      toString: () => "fake locator",
      first: () => ({
        count: async () => 1,
        toString: () => "fake locator",
        boundingBox: async () => (actionable ? { x: 1, y: 1, width: 10, height: 10 } : null),
        click: async (options?: { trial?: boolean }) => {
          if (!actionable) throw new Error("element is not visible");
          void options;
        },
      }),
    }),
  } as never;
}

test("an ask with no history answers nothing, so the locator stays the suspect", async () => {
  const healer = new LocatorHealer();
  assert.equal(await healer.recall("getByRole(\"button\")", "https://a.example/x", fakePage(true)), undefined);
});

test("an ask that still resolves is reported live, not as a repair suggestion", async () => {
  /*
   * The measured waste. A step failed for a reason that had nothing to do with
   * the element, and the model spent its next call re-deriving an element that had
   * never been broken. `live` is the fact that says "look elsewhere".
   */
  const healer = new LocatorHealer();
  healer.remember(intentOfExpression("getByRole(\"button\", { name: \"Continue\" })"), "getByRole(\"button\", { name: \"Continue\" })", "https://a.example/login");
  const recall = await healer.recall(intentOfExpression("getByRole(\"button\", { name: \"Continue\" })"), "https://a.example/login", fakePage(true));
  assert.equal(recall?.state, "live", JSON.stringify(recall));
  assert.equal(recall?.hits, 2, "the trial that confirms it counts as a use");
});

test("an ask that worked before and does not now is reported stale", async () => {
  const healer = new LocatorHealer();
  healer.remember(intentOfExpression("#register-btn"), "#register-btn", "https://a.example/login");
  const recall = await healer.recall(intentOfExpression("#register-btn"), "https://a.example/login", fakePage(false));
  assert.equal(recall?.state, "stale", JSON.stringify(recall));
  assert.equal(recall?.selector, "#register-btn");
  /*
   * Evicted on the way out. Left in place it would be re-trialled on every later
   * step for an answer already known, and its history rides along in this reply.
   */
  assert.equal(healer.size(), 0, "a stale entry is dropped rather than left to be re-trialled");
});

test("history is per site, so a locator that worked elsewhere is not claimed", async () => {
  /*
   * The reason the key carries the host. A `#submit` that works on one site says
   * nothing about another, and offering it across sites would turn a hint into a
   * wrong click.
   */
  const healer = new LocatorHealer();
  healer.remember(intentOfExpression("#submit"), "#submit", "https://a.example/form");
  assert.equal(await healer.recall(intentOfExpression("#submit"), "https://b.example/form", fakePage(true)), undefined);
});

test("the same ask spelled differently keys the same, and a different ask does not", () => {
  /*
   * A model re-writing a step rarely reproduces its own punctuation, so spacing
   * and quote style are normalised. What is *not* unified is two genuinely
   * different spellings of one intent, which the key cannot resolve without a
   * resolved element to read the role and name from. A miss is the honest
   * outcome: it costs a re-derivation, where a wrong hit costs a wrong click.
   */
  assert.equal(
    intentOfExpression('getByRole("button", { name: "Register" })'),
    intentOfExpression("getByRole('button', {name:'Register'})"),
  );
  assert.notEqual(intentOfExpression("#register-btn"), intentOfExpression('getByRole("button", { name: "Register" })'));
});

test("the tool prints the two facts and the skill documents them", async () => {
  /*
   * Source-level for the wiring, because unwired is exactly how this went wrong
   * the first time: the class existed, was correct, and nothing called it.
   */
  const tool = await readFile(new URL("../../../../src/tools/browser/execute-browser-use.ts", import.meta.url), "utf8");
  assert.match(tool, /kit\.recallLocator\(/, "the tool must ask the healer about a failed locator");
  assert.match(tool, /SEEN BEFORE:/, "and print the live fact");
  assert.match(tool, /CHANGED:/, "and the stale one");
  assert.match(tool, /kit\.rememberLocator\(/, "and record what worked, or the cache is never filled");

  const skill = await readFile(new URL("../../../../src/skills/built-in/browser/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /SEEN BEFORE:/, "the model must be told what the line means");
  assert.match(skill, /CHANGED:/);
});
