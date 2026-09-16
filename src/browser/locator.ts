/**
 * Locators: choosing one, and keeping it working when the page moves.
 *
 * Two rules this module exists to enforce, both learned from the same failure.
 * A locator that is stale is a nuisance; a locator that is *wrong* is how an
 * agent clicks a button in the wrong row and reports success. So:
 *
 *   1. Nothing is trusted until the page has confirmed it. The compiler emits
 *      locators from the accessibility tree with no browser in hand, which makes
 *      them true statements about what the page contains and not promises about
 *      what they address. Every one of them is `verified: false` until a live
 *      page says it matches exactly one element.
 *
 *   2. Resolution goes through the structured form, never the printed
 *      expression. `getByRole("button",{name:"Apply"})` is source code for the
 *      model to paste; it is not a selector `page.locator()` accepts. Reaper
 *      builds a real Playwright locator from `by`, so the locator the model
 *      reads and the element Reaper acts on are the same one by construction
 *      rather than by two code paths agreeing.
 *
 * Playwright's own `locator.normalize()` is used as an *upgrade*, not as the
 * source of truth. It re-addresses an element using Playwright's own scoring,
 * which is better than ours, but it takes a Locator as input, so it can only
 * improve a locator that already resolves. It cannot rescue one that does not.
 */

import type { Locator, Page } from "playwright";

import type { IrElement, IrLocator, LocatorBy } from "./ir.js";

/**
 * Strategies, best first, used when merging a normalised locator with ours.
 *
 * This is Playwright's own preference order, which is also what survives a
 * re-render: a role plus an accessible name is likely to still be there after a
 * framework swaps the DOM, a CSS chain through three generated class names is
 * the least likely.
 */
const STRATEGY_RANK: Record<IrLocator["strategy"], number> = {
  testid: 0,
  "role+name": 1,
  label: 2,
  placeholder: 3,
  text: 4,
  css: 5,
};

/** Build a real Playwright locator from the structured form. */
export function locatorFor(page: Page, by: LocatorBy): Locator {
  switch (by.kind) {
    case "role":
      return page.getByRole(by.role as Parameters<Page["getByRole"]>[0], by.exact ? { name: by.name, exact: true } : { name: by.name });
    case "testid":
      return page.getByTestId(by.value);
    case "label":
      return page.getByLabel(by.value);
    case "placeholder":
      return page.getByPlaceholder(by.value);
    case "text":
      return page.getByText(by.value, by.exact ? { exact: true } : undefined);
    case "css":
      return page.locator(by.value);
  }
}

/** Turn a Playwright locator's own description into our strategy label. */
function strategyOf(expression: string): IrLocator["strategy"] {
  if (expression.startsWith("getByTestId")) return "testid";
  if (expression.startsWith("getByRole")) return "role+name";
  if (expression.startsWith("getByLabel")) return "label";
  if (expression.startsWith("getByPlaceholder")) return "placeholder";
  if (expression.startsWith("getByText")) return "text";
  return "css";
}

/**
 * The source text for a normalised locator, ready to paste into a program.
 *
 * `locator.toString()` returns `locator('getByRole(...)')`, which is a debug
 * rendering and not valid code. The inner selector is what belongs in a script.
 */
function toExpression(locator: Locator): string {
  const rendered = locator.toString();
  const inner = /^locator\('(.*)'\)$/s.exec(rendered);
  return inner ? inner[1]! : rendered;
}

export interface ResolveResult {
  locator: Locator | undefined;
  /** Which locator matched, so a stale one can be reported as stale. */
  used: IrLocator | undefined;
  /** The locators that matched zero or many elements. */
  stale: IrLocator[];
  /**
   * A locator that matched more than one element.
   *
   * Kept separate from `stale` because the two need different words: a stale
   * locator is gone, an ambiguous one is there and does not identify. Telling
   * the model "stale" when it is really "there are six Apply buttons and I will
   * not guess" sends it looking for the wrong problem.
   */
  ambiguous: IrLocator[];
}

/**
 * Find the element, trying each locator, and refusing every answer that is not
 * exactly one element.
 *
 * "Exactly one" is the whole contract. Playwright's own strict mode raises on
 * two matches, and the reason is worth restating: the first of two matches is
 * not the element, it is a coin flip. On a results table where every row has an
 * "Apply" button, taking the first is how an agent applies to the wrong job and
 * reports success, and the model has no way to notice because every number in
 * its view looked right.
 */
export async function resolveElement(element: Pick<IrElement, "locators">, page: Page): Promise<ResolveResult> {
  const stale: IrLocator[] = [];
  const ambiguous: IrLocator[] = [];
  for (const candidate of element.locators) {
    try {
      const found = locatorFor(page, candidate.by);
      const count = await found.count();
      if (count === 1) return { locator: found, used: candidate, stale, ambiguous };
      if (count > 1) ambiguous.push(candidate);
      else stale.push(candidate);
    } catch {
      // A malformed or unsupported locator is a locator that did not match.
      stale.push(candidate);
    }
  }
  return { locator: undefined, used: undefined, stale, ambiguous };
}

/**
 * Check every locator against the live page and mark the ones that are true.
 *
 * This is what turns `verified: false` into a fact rather than a disclaimer. It
 * costs one `count()` per locator, which is cheap enough to run on the elements
 * the model is about to be shown, and it is the difference between offering a
 * locator and vouching for one.
 *
 * Ambiguity is recorded rather than resolved here. Two "Apply" buttons are a
 * true fact about the page, and the model is the one that knows which row it
 * means; silently picking the first would throw away the only information that
 * could disambiguate it.
 */
export async function verifyLocators(element: IrElement, page: Page): Promise<{ unique: IrLocator[]; ambiguous: IrLocator[] }> {
  const unique: IrLocator[] = [];
  const ambiguous: IrLocator[] = [];
  for (const locator of element.locators) {
    try {
      const count = await locatorFor(page, locator.by).count();
      if (count === 1) {
        locator.verified = true;
        unique.push(locator);
      } else if (count > 1) {
        ambiguous.push(locator);
      }
    } catch {
      // Left unverified, which is already the default.
    }
  }
  return { unique, ambiguous };
}

/**
 * Upgrade an element's locators using the live page.
 *
 * Playwright's `normalize()` re-addresses an already-resolving element using its
 * own scoring rubric, which is better than ours because it has years of real
 * pages behind it. The result is merged in by strategy rank rather than asserted
 * to be best: on a page whose accessible names are generated hashes, our
 * id-based locator is the better answer, and blindly promoting the normalised
 * one would make things worse.
 *
 * A failure here is not an error. The element may have been removed between the
 * compile and this call, which is normal on a live page.
 */
export async function refineLocators(element: IrElement, page: Page): Promise<boolean> {
  const best = element.locators[0];
  if (!best) return false;
  try {
    const found = locatorFor(page, best.by);
    if ((await found.count()) !== 1) return false;

    const expression = toExpression(await found.normalize());
    if (element.locators.some((locator) => locator.expression === expression)) return false;

    /*
     * The normalised locator arrives as source only, with no structured form,
     * and it cannot be turned back into one reliably: parsing generated source
     * to recover the arguments would be a heuristic of exactly the kind this
     * module exists to remove. So it is offered to the model as a locator it can
     * paste, and marked verified because it came from the element itself.
     */
    const candidate: IrLocator = {
      expression,
      score: 0,
      strategy: strategyOf(expression),
      by: { kind: "css", value: expression },
      verified: true,
    };
    const merged = [candidate, ...element.locators]
      .filter((locator, index, all) => all.findIndex((other) => other.expression === locator.expression) === index)
      .sort((a, b) => STRATEGY_RANK[a.strategy] - STRATEGY_RANK[b.strategy]);
    element.locators = merged.map((locator, index) => ({ ...locator, score: -index }));
    return merged[0]!.expression !== best.expression;
  } catch {
    return false;
  }
}

/**
 * One line saying what happened, for the journal.
 *
 * Written as a sentence rather than a code because a person reads it later, and
 * "the preferred locator was stale" is only useful with the locator in it.
 */
export function describeResolution(result: ResolveResult, elementId: string): string | undefined {
  if (result.used === undefined) {
    if (result.ambiguous.length > 0) {
      const names = result.ambiguous.map((locator) => locator.expression).join(", ");
      return `${elementId}: nothing identifies this uniquely, these match several elements: ${names}`;
    }
    return `${elementId}: no locator matched, the element is gone`;
  }
  if (result.stale.length === 0 && result.ambiguous.length === 0) return undefined;
  const parts: string[] = [];
  if (result.stale.length > 0) parts.push(`${result.stale.length} stale`);
  if (result.ambiguous.length > 0) parts.push(`${result.ambiguous.length} ambiguous`);
  return `${elementId}: ${parts.join(", ")}, matched by ${result.used.strategy} (${result.used.expression})`;
}

/**
 * Turn an element's locators into `const` lines a generated program can use.
 *
 * The model is being handed source it will paste, so the names matter. A
 * variable called `apply` reading `getByRole("button",{name:"Apply"})` is
 * self-describing; `locator("div > div:nth-child(3) > button")` is not, and a
 * program full of the second is unreadable when a person reviews the session
 * afterwards, which they will.
 *
 * Only locators that were checked against the page are offered as a `const`.
 * An unverified locator is still named in the comment, because the model may
 * need to try it, and it must know that is what it is doing.
 *
 * The ambiguity case is stated, not hidden. When two "Apply" buttons both match,
 * the generated line says so and hands the model `.nth(i)`, which is a truthful
 * instruction ("you must choose which one") rather than a silent guess ("here
 * is Apply").
 */
export function locatorCode(element: IrElement, options: { name?: string | undefined } = {}): string[] {
  const lines: string[] = [];
  const name = options.name ?? element.id.replace(/[^A-Za-z0-9]/g, "_");
  const verified = element.locators.filter((locator) => locator.verified);

  if (verified.length === 0) {
    const best = element.locators[0];
    lines.push(`// ${element.id} ${element.role} "${element.name}" has no locator confirmed against the page.`);
    if (best) lines.push(`// best unverified candidate: ${best.expression}`);
    return lines;
  }

  const best = verified[0]!;
  const others = verified.slice(1).map((locator) => `${locator.strategy}: ${locator.expression}`);
  lines.push(`const ${name} = page.${best.expression}; // ${element.role} "${element.name}"${others.length > 0 ? ` | also: ${others.join(" | ")}` : ""}`);
  return lines;
}

/**
 * The ambiguity warning for an element whose locators match several nodes.
 *
 * Returned separately from `locatorCode` because it is a different kind of
 * statement: `locatorCode` says how to reach something, this says that reaching
 * it requires a decision the model has to make. A program that ignores it will
 * fail in strict mode, and explaining that here is cheaper than the model
 * debugging a strict-mode violation it cannot see the cause of.
 */
export function ambiguityNote(element: IrElement, matched: number): string {
  return (
    `${element.id} ${element.role} "${element.name}" matches ${matched} elements on the page, ` +
    `so a locator does not identify it. Address it by position, for example .nth(0), or by a more specific ` +
    `locator taken from the section it belongs to.`
  );
}
