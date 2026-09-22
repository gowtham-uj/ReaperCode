/**
 * `expect`, in the sandbox, for the four assertions a browser program writes.
 *
 * The skill told a model to reach for `expect(locator).toBeVisible()` and the
 * sandbox did not bind the name: `typeof expect` was `"undefined"` inside a
 * program, verified with `vm.compileFunction` and the sandbox's own parameter
 * list. Playwright's assertion is the idiomatic way to wait for a condition, and
 * its absence is a trap rather than a gap: the model writes the documented call,
 * gets a `ReferenceError` that reads as its own mistake, and falls back to a
 * fixed sleep, which is the behaviour the whole wait policy exists to prevent.
 *
 * This is the same four assertions, over the same two things Playwright's own
 * `expect` takes, with the budget from `WAIT_BUDGETS.assertion` rather than a
 * global.
 *
 * ## What it deliberately is not
 *
 * It is not `@playwright/test`'s `expect`, and it is not a re-export of it. Two
 * reasons, and both were checked against the installed library:
 *
 *   - `expect` is a named export of `@playwright/test`, which is not a
 *     dependency of Reaper; the package that is installed, `playwright`, does
 *     not export it at all (verified: `Object.keys(require("playwright"))` has
 *     no `expect`).
 *   - Even if it were, Playwright's matchers take their timeout from a test
 *     runner's configuration, and there is no runner here. A matcher that
 *     silently inherits a 30 second default is the exact cost the wait policy
 *     was written to remove.
 *
 * ## Pass and fail
 *
 * A passing assertion returns its evidence, and a failing one throws. Throwing
 * is the load-bearing half: `await expect(locator).toBeVisible();` discards the
 * return value, so an assertion that only reported a failure in a return value
 * would be a no-op that a model could not distinguish from a pass. The thrown
 * error's name is `ExpectError` and its message carries the assertion, what was
 * expected, what was found, and the locator, so a program that catches it (and a
 * receipt that shows it) says which check failed without a second call.
 *
 * Retried until the budget runs out, because the point of an assertion is to
 * wait for a condition rather than to sample it once. The retry interval is a
 * tenth of the budget, which is short enough to notice a fast change and long
 * enough not to spin on the CDP bridge.
 */
import type { Locator, Page } from "playwright";

/** The assertions a program may make. */
export type ExpectAssertion = "toBeVisible" | "toHaveText" | "toContainText" | "toHaveURL";

/**
 * The same four, as a set, for the refusal message and for the sandbox.
 *
 * One list rather than two is the point: the sandbox's `expect` answers the name
 * a program asked for without checking it, and the host is the only place that
 * knows which names exist. Naming them here means an unknown assertion is
 * refused with the list rather than answered with `undefined`.
 */
export const EXPECT_ASSERTIONS: ReadonlySet<string> = new Set<ExpectAssertion>([
  "toBeVisible",
  "toHaveText",
  "toContainText",
  "toHaveURL",
]);

export interface ExpectOptions {
  /** How long to keep retrying, in milliseconds. Defaults to the assertion budget. */
  timeoutMs?: number;
  /**
   * The budget name or number the program passed, resolved by the caller.
   *
   * Kept separate from `timeoutMs` so the receipt can say which one was in force
   * rather than only the number it became.
   */
  timeoutNote?: string;
}

export interface ExpectResult {
  /** Always true: a false assertion throws rather than returning. */
  pass: true;
  /** Which assertion ran, by name. */
  assertion: ExpectAssertion;
  /** What the target was, in words, for the receipt. */
  target: string;
  /** What was expected, when the assertion had an expected value. */
  expected?: string;
  /** What was found: the visible flag, the text, or the URL. */
  actual: string;
  /** One line a model can read without reconstructing anything. */
  message: string;
  /** How many attempts it took, which is the honest cost of the check. */
  attempts: number;
  /** How long it was given, in milliseconds. */
  timeoutMs: number;
}

/**
 * A failed assertion, as a distinguishable error.
 *
 * Named rather than anonymous so a program can tell "the page did not do the
 * thing" from "the bridge broke", which call for different retries: the first is
 * a fact about the page and the second is a fact about the transport.
 */
export class ExpectError extends Error {
  constructor(
    readonly assertion: ExpectAssertion,
    readonly target: string,
    readonly expected: string | undefined,
    readonly actual: string,
    readonly attempts: number,
  ) {
    super(
      `expected ${target} ${describeExpectation(assertion, expected)} ` +
      `but found ${actual} (after ${attempts} attempt${attempts === 1 ? "" : "s"})`,
    );
    this.name = "ExpectError";
  }
}

/** The assertion, in prose, for a failure or a receipt line. */
function describeExpectation(assertion: ExpectAssertion, expected: string | undefined): string {
  switch (assertion) {
    case "toBeVisible":
      return "to be visible";
    case "toHaveText":
      return `to have text ${expected ?? "(nothing given)"}`;
    case "toContainText":
      return `to contain text ${expected ?? "(nothing given)"}`;
    case "toHaveURL":
      return `to have URL ${expected ?? "(nothing given)"}`;
  }
}

/**
 * The target, named for a human.
 *
 * A Locator is described by Playwright's own `toString`, which is the chain the
 * program wrote. A Page is named by its URL, because "the page" on a thread with
 * four tabs says nothing about which one failed.
 */
function nameOf(target: Locator | Page): string {
  const described = describeLocator(target);
  if (described !== undefined) return described;
  return `page ${(target as Page).url()}`;
}

/** Playwright's own description of a locator, or undefined when it is not one. */
function describeLocator(value: unknown): string | undefined {
  const candidate = value as { toString?: () => string; goto?: unknown };
  if (isLocatorLike(value) !== true) return undefined;
  try {
    const text = typeof candidate.toString === "function" ? candidate.toString() : "";
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for a Playwright Locator, by shape rather than by class.
 *
 * The same test the runtime uses to tell a locator from a page, and for the same
 * reason: Playwright's classes are internal-prefixed and an `instanceof` across
 * a version boundary is fragile. A locator can snapshot itself and cannot
 * navigate.
 */
export function isLocatorLike(value: unknown): value is Locator {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ariaSnapshot"] === "function" && typeof candidate["goto"] !== "function";
}

/** True for a Playwright Page, by shape. */
function isPageLike(value: unknown): value is Page {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["goto"] === "function" && typeof candidate["url"] === "function";
}

/** Whitespace-normalised text, which is how Playwright compares text too. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The element's text, or empty when it is not there yet.
 *
 * `textContent()` resolves to `string | null`: null for an element with no text
 * node at all, which is different from the empty string and the same thing to
 * every assertion here. The catch covers the element not being attached.
 */
async function textOf(locator: Locator): Promise<string> {
  return (await locator.textContent().catch(() => null)) ?? "";
}

/** Whether the element is visible right now. */
async function visibleOf(locator: Locator): Promise<boolean> {
  return await locator.isVisible().catch(() => false);
}

/**
 * One sampling of the condition, and what it found.
 *
 * Returns the raw value rather than a boolean so the failure message can report
 * what was actually there: "found \"Search\"", not "expected true, found false",
 * which is the difference between a fixable answer and a shrug.
 */
async function sample(
  assertion: ExpectAssertion,
  target: Locator | Page,
  expected: string | RegExp | undefined,
): Promise<{ ok: boolean; actual: string }> {
  switch (assertion) {
    case "toBeVisible": {
      if (isLocatorLike(target) !== true) {
        throw new ExpectError(assertion, nameOf(target), "an element", "a target that is not a locator", 1);
      }
      const visible = await visibleOf(target);
      return { ok: visible, actual: visible ? "visible" : "not visible" };
    }
    case "toHaveText":
    case "toContainText": {
      if (isLocatorLike(target) !== true) {
        throw new ExpectError(assertion, nameOf(target), "an element", "a target that is not a locator", 1);
      }
      const text = normalize(await textOf(target));
      if (expected === undefined) return { ok: false, actual: `text ${JSON.stringify(text)}` };
      if (expected instanceof RegExp) {
        return { ok: expected.test(text), actual: `text ${JSON.stringify(text)}` };
      }
      const needle = normalize(expected);
      const ok = assertion === "toHaveText" ? text === needle : text.includes(needle);
      return { ok, actual: `text ${JSON.stringify(text)}` };
    }
    case "toHaveURL": {
      const page = resolvePage(target);
      const url = page.url();
      if (expected === undefined) return { ok: false, actual: `URL ${url}` };
      if (expected instanceof RegExp) return { ok: expected.test(url), actual: `URL ${url}` };
      /*
       * A string is an exact match, which is what Playwright's own `toHaveURL`
       * does with a string. Documented rather than loosened: a substring match
       * is what a RegExp is for, and a check that quietly accepted a partial URL
       * would pass on `/results` and on `/results-old`, which is the class of
       * false pass an assertion exists to prevent.
       */
      return { ok: url === expected, actual: `URL ${url}` };
    }
  }
}

/**
 * The page an assertion is about.
 *
 * A locator carries its page, which is what makes `expect(locator).toHaveURL()`
 * meaningful for a program driving a tab it never switched to.
 */
function resolvePage(target: Locator | Page): Page {
  if (isPageLike(target)) return target;
  if (isLocatorLike(target)) {
    try {
      return (target as Locator).page();
    } catch (error) {
      throw new ExpectError("toHaveURL", nameOf(target), undefined, "a locator with no page", 1);
    }
  }
  throw new ExpectError("toHaveURL", "the target", undefined, "neither a page nor a locator", 1);
}

/**
 * Run one assertion, retrying until the budget runs out.
 *
 * Throws `ExpectError` on failure and returns the evidence on success. The
 * caller decides the budget; there is no default here so a call site cannot
 * accidentally take Playwright's thirty second one.
 */
export async function runExpectation(
  assertion: ExpectAssertion,
  target: unknown,
  expected: string | RegExp | undefined,
  options: ExpectOptions,
): Promise<ExpectResult> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 5_000;
  const interval = Math.max(50, Math.floor(timeoutMs / 10));
  const deadline = Date.now() + timeoutMs;
  const named = nameOf(target as Locator | Page);

  let attempts = 0;
  let last: { ok: boolean; actual: string } = { ok: false, actual: "nothing read" };
  for (;;) {
    attempts += 1;
    last = await sample(assertion, target as Locator | Page, expected);
    if (last.ok) {
      return {
        pass: true,
        assertion,
        target: named,
        ...(expected !== undefined ? { expected: String(expected) } : {}),
        actual: last.actual,
        message: `${named} ${describeExpectation(assertion, expected !== undefined ? String(expected) : undefined)}: ok (${last.actual})`,
        attempts,
        timeoutMs,
      };
    }
    if (Date.now() + interval > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new ExpectError(assertion, named, expected !== undefined ? String(expected) : undefined, last.actual, attempts);
}
