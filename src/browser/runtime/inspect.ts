/**
 * `browser.inspect`: ask whether an element can be acted on, before acting.
 *
 * This solves the zero-width delete button without a custom DOM engine, because
 * Playwright already answers the question. It checks that a click target is
 * visible, stable, enabled and receiving pointer events, and it will perform all
 * four checks without actually clicking:
 *
 *     await locator.click({ trial: true });
 *
 * A zero-size element is not visible, so the trial fails and says so. What the
 * trial does not do is explain which check failed, and that is what this adds: it
 * runs the trial, and when the trial fails it reads the element's geometry and
 * its local neighbourhood so the model gets a reason rather than a timeout.
 *
 * The measured shape this replaces, from a live mission:
 *
 *     click -> 30s -> fail -> think -> inspect DOM -> think -> click child
 *
 * and the shape this produces:
 *
 *     trial click -> 1.5s -> ZERO_AREA -> inspect children -> click the icon
 *
 * The difference is twenty-nine seconds and two reasoning passes, per
 * occurrence, and this failure recurs whenever a page uses an icon inside a
 * zero-size anchor, which is most pages with a delete button.
 */

import type { Locator, Page } from "playwright";

import { classifyFailure, type BrowserFailure } from "./failure.js";

export interface ActionInspection {
  /** The locator as the model wrote it, for the receipt. */
  locator: string;
  /** How many elements it matched. Anything but one is a problem on its own. */
  count: number;
  /** Whether a trial action succeeded. */
  actionable: boolean;
  /** The element's box, when it has one. */
  box?: { x: number; y: number; width: number; height: number };
  /** Why it is not actionable, classified rather than raw. */
  failure?: BrowserFailure;
  /**
   * What is inside or around the element, when it cannot be acted on.
   *
   * The fix for a zero-area container is almost always to click something inside
   * it, so the inspection answers with the children that *do* have boxes rather
   * than making the model go and look. Bounded to a handful, because a menu with
   * forty items does not need all of them listed to make the point.
   */
  candidates?: Array<{ tag: string; text: string; box: { x: number; y: number; width: number; height: number } }>;
  /** Whatever is covering the element, when something is. */
  covering?: { tag: string; text: string; zIndex: string };
}

/** The trial's budget. Short on purpose: this is a diagnostic, not an action. */
export const INSPECT_TRIAL_TIMEOUT_MS = 1_500;

/**
 * Inspect one locator.
 *
 * `action` decides which trial runs, because the actionability conditions differ
 * by verb: a `fill` requires the element to be editable and a `click` requires
 * it to receive pointer events, and an element can pass one and fail the other.
 */
export async function inspectLocator(
  page: Page,
  locator: Locator,
  action: "click" | "fill" | "check" | "hover" = "click",
): Promise<ActionInspection> {
  const description = describe(locator);
  const count = await locator.count().catch(() => 0);
  if (count !== 1) {
    return {
      locator: description,
      count,
      actionable: false,
      failure: classifyFailure(
        new Error(
          count === 0
            ? `locator('${description}') resolved to 0 elements`
            : `strict mode violation: locator('${description}') resolved to ${count} elements`,
        ),
      ),
    };
  }

  /*
   * The box is read before the trial, because a zero-area element's trial
   * failure is reported as "not visible" and the box is what turns that into the
   * actionable ZERO_AREA. Reading it first also means the inspection still has
   * geometry to report when the trial hangs on a covered element.
   */
  const box = await locator.boundingBox().catch(() => null);

  try {
    await runTrial(locator, action);
    return {
      locator: description,
      count,
      actionable: true,
      ...(box !== null ? { box } : {}),
    };
  } catch (error) {
    const failure = classifyFailure(error, box ?? undefined);
    const inspection: ActionInspection = {
      locator: description,
      count,
      actionable: false,
      ...(box !== null ? { box } : {}),
      failure,
    };
    /*
     * The two failures that have a mechanical next step get the evidence for it
     * attached. Everything else is answered by the classifier alone, because a
     * model told "the element is disabled" does not need a list of its
     * neighbours to act.
     */
    if (failure.kind === "ZERO_AREA" || failure.kind === "NOT_VISIBLE") {
      const candidates = await clickableDescendants(locator);
      if (candidates.length > 0) inspection.candidates = candidates;
    }
    if (failure.kind === "NOT_RECEIVING_EVENTS") {
      const covering = await coveringElement(page, box ?? undefined);
      if (covering !== undefined) inspection.covering = covering;
    }
    return inspection;
  }
}

/** Run the trial for one verb, so the actionability conditions match the action. */
async function runTrial(locator: Locator, action: "click" | "fill" | "check" | "hover"): Promise<void> {
  const options = { trial: true as const, timeout: INSPECT_TRIAL_TIMEOUT_MS };
  switch (action) {
    case "fill":
      await locator.fill("", options);
      return;
    case "check":
      await locator.check(options);
      return;
    case "hover":
      await locator.hover(options);
      return;
    default:
      await locator.click(options);
  }
}

/**
 * The descendants that have a real box.
 *
 * This is the answer to a zero-area container: the thing the model should click
 * is inside it. Bounded, and each one carries its own text and geometry so the
 * model can write a locator for it without another look.
 */
async function clickableDescendants(
  locator: Locator,
): Promise<Array<{ tag: string; text: string; box: { x: number; y: number; width: number; height: number } }>> {
  const raw = await locator
    .evaluate((element: Element) => {
      const out: Array<{ tag: string; text: string; rect: { x: number; y: number; width: number; height: number } }> = [];
      const nodes = Array.from(element.querySelectorAll("*"));
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        out.push({
          tag: node.tagName.toLowerCase(),
          text: (node.textContent ?? "").trim().slice(0, 60),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
        if (out.length >= 6) break;
      }
      return out;
    })
    .catch(() => [] as Array<{ tag: string; text: string; rect: { x: number; y: number; width: number; height: number } }>);
  return raw.map((entry) => ({ tag: entry.tag, text: entry.text, box: entry.rect }));
}

/**
 * What is actually at the element's centre.
 *
 * `elementFromPoint` is the browser's own answer to "what would receive this
 * click", which is exactly the question, and it is asked at the element's centre
 * because that is where Playwright would have clicked.
 */
async function coveringElement(
  page: Page,
  box: { x: number; y: number; width: number; height: number } | undefined,
): Promise<{ tag: string; text: string; zIndex: string } | undefined> {
  if (box === undefined || box.width === 0 || box.height === 0) return undefined;
  return await page
    .evaluate(
      ([x, y]: [number, number]) => {
        const node = document.elementFromPoint(x, y);
        if (node === null) return undefined;
        const style = window.getComputedStyle(node);
        return {
          tag: node.tagName.toLowerCase(),
          text: (node.textContent ?? "").trim().slice(0, 60),
          zIndex: style.zIndex,
        };
      },
      [box.x + box.width / 2, box.y + box.height / 2] as [number, number],
    )
    .catch(() => undefined);
}

/**
 * A locator as a string a model can reuse.
 *
 * Best effort: Playwright does not expose the selector a Locator was built from,
 * so this reconstructs the conventional form. When it cannot, the model still
 * has the count, the box and the failure, which is the part that matters.
 */
function describe(locator: Locator): string {
  const raw = locator as unknown as { toString?: () => string };
  try {
    return raw.toString?.() ?? "locator";
  } catch {
    return "locator";
  }
}

/** The inspection as the model reads it. */
export function renderInspection(inspection: ActionInspection): string {
  const lines = [`INSPECT ${inspection.locator}`];
  lines.push(`  matches: ${inspection.count}`);
  if (inspection.box !== undefined) {
    lines.push(`  box: ${inspection.box.width}x${inspection.box.height} at (${inspection.box.x}, ${inspection.box.y})`);
  }
  if (inspection.actionable) {
    lines.push("  actionable: yes, this element passes every readiness check.");
    return lines.join("\n");
  }
  if (inspection.failure !== undefined) {
    lines.push(`  actionable: no`);
    lines.push(`  ${inspection.failure.kind}: ${inspection.failure.diagnostic}`);
    if (inspection.failure.recommendedNext !== undefined) lines.push(`  next: ${inspection.failure.recommendedNext}`);
  }
  if (inspection.covering !== undefined) {
    lines.push(`  covered by: <${inspection.covering.tag}> "${inspection.covering.text}" (z-index ${inspection.covering.zIndex})`);
  }
  if (inspection.candidates !== undefined && inspection.candidates.length > 0) {
    lines.push("  children with a real box, any of which can be clicked:");
    for (const candidate of inspection.candidates) {
      lines.push(`    <${candidate.tag}> "${candidate.text}" ${candidate.box.width}x${candidate.box.height}`);
    }
  }
  return lines.join("\n");
}
