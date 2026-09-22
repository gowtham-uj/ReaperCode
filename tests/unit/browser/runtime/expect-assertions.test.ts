/**
 * `expect` inside a browser program, which the skill documented and the sandbox
 * did not bind.
 *
 * `SKILL.md` told the model to write `await expect(locator).toBeVisible()` and
 * `wait-policy.ts` repeated it, while `vm.compileFunction` with the worker's own
 * parameter list gave `typeof expect === "undefined"`. So the documented call
 * threw a `ReferenceError` that reads as the model's own mistake, and the model
 * fell back to the fixed sleep the wait policy exists to remove.
 *
 * The assertions are retried rather than sampled once, because the point of an
 * assertion is to wait for a condition. The tests below use fakes with a scripted
 * answer sequence, so "it retried until the element appeared" is asserted rather
 * than assumed, and the timeout is short so the failure cases are quick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EXPECT_ASSERTIONS, ExpectError, isLocatorLike, runExpectation } from "../../../../src/browser/runtime/expect.js";

/** A locator stand-in whose visibility and text follow a scripted sequence. */
function scriptedLocator(script: { visible?: boolean; text?: string }[]) {
  let index = 0;
  const at = (): { visible?: boolean; text?: string } => script[Math.min(index, script.length - 1)]!;
  return {
    ariaSnapshot: async () => "- fake",
    isVisible: async () => {
      const step = at();
      index += 1;
      return step.visible ?? false;
    },
    textContent: async () => at().text ?? "",
    toString: () => 'locator("main")',
  };
}

/** A locator that answers `textContent` only, for the text assertions. */
function textLocator(values: (string | null)[]) {
  let index = 0;
  return {
    ariaSnapshot: async () => "- fake",
    isVisible: async () => true,
    textContent: async () => values[Math.min(index++, values.length - 1)] ?? null,
    toString: () => 'locator("h1")',
  };
}

test("the four documented assertions are the whole set", () => {
  /*
   * One list, because the sandbox answers the name a program asked for without
   * checking it and the host is the only place that knows which names exist. A
   * name outside this set must be refused with the list rather than answered
   * with `undefined`, which is the shape of the bug this file exists for.
   */
  assert.deepEqual([...EXPECT_ASSERTIONS].sort(), ["toBeVisible", "toContainText", "toHaveText", "toHaveURL"]);
});

test("a locator is told apart from a page by shape", () => {
  /* The same test the runtime uses, and the same reason: no `instanceof`. */
  assert.equal(isLocatorLike(scriptedLocator([{ visible: true }])), true);
  assert.equal(isLocatorLike({ goto: async () => undefined, url: () => "about:blank" }), false);
  assert.equal(isLocatorLike(null), false);
  assert.equal(isLocatorLike("locator"), false);
});

test("toBeVisible waits for the element rather than sampling once", async () => {
  /*
   * The behaviour a fixed sleep was standing in for. The first two samples are
   * hidden and the third is visible, so a single-sample implementation fails and
   * a retrying one passes, and the attempt count is the evidence.
   */
  const locator = scriptedLocator([{ visible: false }, { visible: false }, { visible: true }]);
  const result = await runExpectation("toBeVisible", locator as never, undefined, { timeoutMs: 2000 });
  assert.equal(result.pass, true);
  assert.ok(result.attempts >= 3, `it must have retried, saw ${result.attempts} attempt(s)`);
  assert.match(result.message, /toBeVisible|be visible/);
});

test("a failing assertion throws rather than returning a false flag", async () => {
  /*
   * The load-bearing half. `await expect(locator).toBeVisible();` discards the
   * return value, so an assertion that reported failure only in its result would
   * be a no-op indistinguishable from a pass.
   */
  const locator = scriptedLocator([{ visible: false }]);
  await assert.rejects(
    () => runExpectation("toBeVisible", locator as never, undefined, { timeoutMs: 200 }),
    (error: unknown) => {
      assert.ok(error instanceof ExpectError, "the failure must be its own error class");
      assert.equal((error as ExpectError).assertion, "toBeVisible");
      assert.match((error as Error).message, /to be visible/);
      return true;
    },
  );
});

test("toHaveText matches the element's text, and reports what it found", async () => {
  const locator = textLocator([null, "Welcome back"]);
  const result = await runExpectation("toHaveText", locator as never, "Welcome back", { timeoutMs: 2000 });
  assert.equal(result.pass, true);
  assert.match(result.actual, /Welcome back/);
});

test("a null textContent is empty text, not a crash", async () => {
  /*
   * `textContent()` resolves to `string | null`, and null is the ordinary answer
   * for an element with no text node. It is different from the empty string in
   * Playwright's types and identical to every assertion here, so it must not
   * reach the caller as `null`.
   */
  const locator = textLocator([null, null, ""]);
  const result = await runExpectation("toHaveText", locator as never, "", { timeoutMs: 500 });
  assert.equal(result.pass, true);
  assert.match(result.actual, /text ""/, "a null textContent must read as empty text, not as the string 'null'");
});

test("toContainText passes on a substring the element holds", async () => {
  const locator = textLocator(["Total: 42.00 USD"]);
  const result = await runExpectation("toContainText", locator as never, "42.00", { timeoutMs: 500 });
  assert.equal(result.pass, true);
});

test("toHaveURL matches a regex, and a string is an exact match", async () => {
  /*
   * Both halves matter and they are deliberately different. A RegExp is the
   * substring tool; a string is an exact match, which is what Playwright's own
   * `toHaveURL` does. Loosening the string case to a substring would pass on
   * both `/results` and `/results-old`, which is the false pass an assertion
   * exists to prevent, so the strict case is asserted rather than assumed.
   */
  const page = { goto: async () => undefined, url: () => "https://example.com/dashboard", toString: () => "page" };
  const byRegex = await runExpectation("toHaveURL", page as never, /\/dashboard/, { timeoutMs: 500 });
  assert.equal(byRegex.pass, true);

  const exact = await runExpectation("toHaveURL", page as never, "https://example.com/dashboard", { timeoutMs: 500 });
  assert.equal(exact.pass, true);

  await assert.rejects(
    () => runExpectation("toHaveURL", page as never, "/dashboard", { timeoutMs: 150 }),
    /to have URL/,
    "a bare path is not the full URL, and the strict comparison must refuse it",
  );
});

test("a failure names the target so a thread with several tabs says which one", async () => {
  const page = { goto: async () => undefined, url: () => "https://example.com/login", toString: () => "page" };
  await assert.rejects(
    () => runExpectation("toHaveURL", page as never, /\/dashboard/, { timeoutMs: 200 }),
    (error: unknown) => {
      assert.match((error as Error).message, /login/, "the URL that was found must be in the message");
      assert.match((error as Error).message, /dashboard/, "and the one that was expected");
      return true;
    },
  );
});

test("the host's assertion set and the sandbox's list name the same four", async () => {
  /*
   * A drift guard, and the reason it exists is a verifier finding: the host
   * documents a refusal that lists the supported assertions, but the host never
   * receives an unknown name because the sandbox answers the property first. So
   * the sandbox spells its own list, and two lists can drift. This reads the
   * sandbox source and asserts the sets are equal, which is the cheap version of
   * the check that would have caught the original "expect is undefined" bug.
   */
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../../../src/browser/remote-page-source.ts", import.meta.url), "utf8");
  const match = /const EXPECT_NAMES = \[([^\]]+)\]/.exec(source);
  assert.ok(match, "the sandbox must declare its assertion names in one place");
  const named = match![1]!.split(",").map((entry) => entry.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  assert.deepEqual(
    [...named].sort(),
    [...EXPECT_ASSERTIONS].sort(),
    "the sandbox list and the host set must be the same assertions",
  );
});
