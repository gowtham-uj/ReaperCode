/**
 * Looking at a page, cheapest first.
 *
 * The fallback problem: a model that cannot tell what changed asks for the page,
 * and the page is forty-seven thousand characters. It pays that for a question
 * that usually has a local answer, which is how a fifty-five minute mission
 * spends eleven million input tokens without the model doing anything wrong.
 *
 * So looking is a ladder, and each rung is only reached when the one above it
 * did not answer.
 *
 *   0  the transaction receipt         a few hundred tokens
 *   1  a locator or element            one element's attributes and box
 *   2  a scoped ariaSnapshotJSON       the region, mode "ai", with refs and boxes
 *   3  a deeper scoped snapshot        the same region, more depth
 *   4  the whole page                  ariaSnapshotJSON, full
 *   5  a screenshot                    for the cases text cannot describe
 *
 * Everything from rung 2 down is Playwright's own API. Playwright 1.63 ships
 * `ariaSnapshotJSON`, and its `mode: "ai"` is explicitly the machine-oriented
 * serialisation, with `boxes: true` adding the geometry that makes a zero-area
 * element visible as zero-area. There is no custom perception engine in this
 * path, which is deliberate: the fallback has to be the thing most likely to
 * still work when the clever thing does not.
 *
 * `depth` is a parameter rather than a constant because it is the one knob that
 * changes the answer rather than its size, and it does so non-monotonically.
 * Measured on Hacker News: `depth: 6` returns 8,729 characters and looks like
 * the obvious saving, but it folds nav links into their parent's accessible name
 * so the page's 225 addressable actions collapse to 8. A rung that returns a
 * page which looks complete and cannot be acted on is worse than a rung that
 * returns nothing, so the scoped rungs start shallow and the escalation to a
 * deeper scope is explicit.
 */

import type { Page } from "playwright";

/** Which rung an observation came from. */
export type ObserveLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ObserveOptions {
  /** The region to look at. Absent means the whole page. */
  scope?: unknown | undefined;
  /** How deep to read a scoped region. Rung 2 and 3 differ by this. */
  depth?: number | undefined;
  /** A CSS selector for the scope, when the caller has one rather than a locator. */
  selector?: string | undefined;
  /** Include element geometry in the snapshot. On by default for a scoped read. */
  boxes?: boolean | undefined;
}

export interface Observation {
  level: ObserveLevel;
  text: string;
  chars: number;
  /** True when nothing more specific could be read, so the page was returned whole. */
  wholePage: boolean;
}

/** Depth for rung 2, which is a region read. */
export const SCOPED_DEPTH = 4;
/** Depth for rung 3, which is the same region read harder. */
export const DEEP_DEPTH = 10;

/**
 * Rung 1: read one element rather than the page.
 *
 * Used when the model already knows which element it is asking about and wants
 * to know why it is not working. Answered as attributes and geometry, which is
 * what `inspect` needs and what a form diagnostic needs, rather than as a
 * snapshot of the element, which would include everything inside it.
 */
export async function observeElement(locator: { evaluate: Function; count: Function }, depth = 1): Promise<Observation> {
  void depth;
  const text = await (locator.evaluate as (fn: (element: Element) => unknown) => Promise<unknown>)((element: Element) => {
    const rect = element.getBoundingClientRect();
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) attributes[attribute.name] = attribute.value.slice(0, 120);
    return {
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? "").trim().slice(0, 200),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      attributes,
    };
  });
  const rendered = JSON.stringify(text, null, 2);
  return { level: 1, text: rendered, chars: rendered.length, wholePage: false };
}

/**
 * Rung 2 and 3: a scoped AI-mode snapshot.
 *
 * `mode: "ai"` because it is the serialisation Playwright maintains for exactly
 * this, and `boxes: true` because geometry is what turns "not visible" into an
 * actionable fact. Falls back to `ariaSnapshot` when `ariaSnapshotJSON` is
 * missing, which happens on a Playwright older than 1.63, so this degrades
 * rather than throwing.
 */
export async function observeScoped(
  page: Page,
  options: { locator?: unknown; selector?: string; depth?: number; boxes?: boolean } = {},
): Promise<Observation> {
  const depth = options.depth ?? SCOPED_DEPTH;
  const boxes = options.boxes ?? true;
  const target = options.locator !== undefined && options.locator !== null
    ? (options.locator as { ariaSnapshotJSON?: Function; ariaSnapshot?: Function })
    : options.selector !== undefined
      ? (page.locator(options.selector).first() as unknown as { ariaSnapshotJSON?: Function; ariaSnapshot?: Function })
      : (page as unknown as { ariaSnapshotJSON?: Function; ariaSnapshot?: Function });

  const text = await snapshotText(target, depth, boxes);
  return { level: options.depth !== undefined && options.depth > SCOPED_DEPTH ? 3 : 2, text, chars: text.length, wholePage: false };
}

/**
 * Rung 4: the whole page.
 *
 * The expensive rung, and the one the previous implementation used for every
 * observation. Reached only when a scoped read could not answer, which is the
 * honest reason to pay for it.
 */
export async function observeWholePage(page: Page, options: { depth?: number; boxes?: boolean } = {}): Promise<Observation> {
  const target = page as unknown as { ariaSnapshotJSON?: Function; ariaSnapshot?: Function };
  const text = await snapshotText(target, options.depth, options.boxes ?? false);
  return { level: 4, text, chars: text.length, wholePage: true };
}

/**
 * The snapshot itself, preferring the JSON serialisation and degrading to the
 * text one.
 *
 * Not a compatibility shim for its own sake: the two are different formats and
 * the model reads both, so the degradation has to be visible in the text itself
 * rather than silent. A JSON snapshot carries refs that `page.locator("aria-ref=")`
 * resolves; the text one carries the same refs in a different syntax. Both are
 * operable, which is what matters.
 */
async function snapshotText(
  target: { ariaSnapshotJSON?: Function; ariaSnapshot?: Function },
  depth: number | undefined,
  boxes: boolean,
): Promise<string> {
  if (typeof target.ariaSnapshotJSON === "function") {
    const json = await (target.ariaSnapshotJSON as (options: Record<string, unknown>) => Promise<unknown>)({
      mode: "ai",
      ...(depth !== undefined ? { depth } : {}),
      ...(boxes ? { boxes: true } : {}),
    });
    return typeof json === "string" ? json : JSON.stringify(json);
  }
  if (typeof target.ariaSnapshot === "function") {
    return await (target.ariaSnapshot as (options: Record<string, unknown>) => Promise<string>)({
      mode: "ai",
      ...(depth !== undefined ? { depth } : {}),
    });
  }
  throw new Error("this browser cannot snapshot a page: neither ariaSnapshotJSON nor ariaSnapshot is available");
}

/**
 * Rung 5: an image.
 *
 * Last because it is the most expensive to carry and the hardest to act on: the
 * model can read a screenshot and cannot write a locator from it. It exists for
 * the case text genuinely cannot describe, which is a layout problem or a visual
 * state, and it is a deliberate escalation rather than a default.
 */
export async function observeScreenshot(page: Page, options: { fullPage?: boolean } = {}): Promise<Observation> {
  const bytes = await page.screenshot({ fullPage: options.fullPage ?? false, type: "png" });
  const base64 = Buffer.from(bytes).toString("base64");
  return { level: 5, text: base64, chars: base64.length, wholePage: true };
}

/** The ladder as the model reads it, when it needs to know which rung answered. */
export function renderObservation(observation: Observation, note?: string): string {
  const label = ["receipt", "element", "scoped snapshot", "deep scoped snapshot", "whole page", "screenshot"][observation.level];
  return [`OBSERVED at level ${observation.level} (${label}), ${observation.chars} chars${note !== undefined ? ` - ${note}` : ""}`, observation.text].join("\n");
}
