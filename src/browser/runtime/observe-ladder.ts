/**
 * A scoped read of a region, in Playwright's own AI-mode snapshot.
 *
 * The problem it solves: a model that cannot tell what changed asks for the
 * page, and the page is forty-seven thousand characters. It pays that for a
 * question that usually has a local answer, which is how a fifty-five minute
 * mission spends eleven million input tokens without the model doing anything
 * wrong.
 *
 * So a region is read rather than the page, and the read uses Playwright 1.63's
 * `ariaSnapshotJSON` with `mode: "ai"`, which is explicitly the
 * machine-oriented serialisation. `boxes: true` adds the geometry that makes a
 * zero-area element visible as zero-area, which the text form cannot show.
 *
 * `depth` is a parameter rather than a constant because it is the one knob that
 * changes the *answer* rather than its size, and it does so non-monotonically.
 * Measured on Hacker News: `depth: 6` returns 8,729 characters and looks like
 * the obvious saving, but it folds nav links into their parent's accessible name
 * so the page's 225 addressable actions collapse to 8. A read that returns a
 * page which looks complete and cannot be acted on is worse than one that
 * returns nothing, so the depth here is shallow and raising it is explicit.
 */

import type { Page } from "playwright";

export interface Observation {
  /** 2 for a region read at the default depth, 3 for a deepened one. */
  level: 2 | 3;
  text: string;
  chars: number;
}

/** The default depth for a region read. */
export const SCOPED_DEPTH = 4;


/**
 * A scoped AI-mode snapshot of one region.
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
  return { level: options.depth !== undefined && options.depth > SCOPED_DEPTH ? 3 : 2, text, chars: text.length };
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
  /*
   * Bounded, for the same reason `perceive` is: a page whose document never
   * finished loading makes the snapshot wait forever, and an unbounded wait here
   * costs the context default of thirty seconds on a read the model asked for.
   * The scoped path is the one a model reaches for *because* a page is being
   * difficult, so it is the one that must not hang.
   */
  const timeout = 15_000;
  if (typeof target.ariaSnapshotJSON === "function") {
    const json = await (target.ariaSnapshotJSON as (options: Record<string, unknown>) => Promise<unknown>)({
      mode: "ai",
      timeout,
      ...(depth !== undefined ? { depth } : {}),
      ...(boxes ? { boxes: true } : {}),
    });
    return typeof json === "string" ? json : JSON.stringify(json);
  }
  if (typeof target.ariaSnapshot === "function") {
    return await (target.ariaSnapshot as (options: Record<string, unknown>) => Promise<string>)({
      mode: "ai",
      timeout,
      ...(depth !== undefined ? { depth } : {}),
    });
  }
  throw new Error("this browser cannot snapshot a page: neither ariaSnapshotJSON nor ariaSnapshot is available");
}


