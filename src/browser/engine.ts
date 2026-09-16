/**
 * What the model reads about a page, and what happens when the compiler fails.
 *
 * One call that turns a live page into text. It exists because the alternative
 * was the same five steps repeated at every call site, and because the fallback
 * has to live somewhere that every caller goes through: a fallback that only
 * some paths take is a fallback that fires inconsistently, which is worse than
 * one that does not exist.
 *
 *     collect      four CDP sources, merged on backend node id
 *     compile      the semantic reduction
 *     render       the model view, budgeted, sections and rows
 *     fallback     Playwright's own snapshot, when any of the above fails
 *
 * ## Why the primary is ours and not Playwright's
 *
 * Measured on Hacker News: the raw `ariaSnapshot({mode:"ai"})` is 47,683
 * characters and the compiled view of the same page is 1,391, with locators for
 * every row. That is the whole argument. Playwright's snapshot is a faithful
 * tree of everything on the page; the compiler answers "what can be done here".
 *
 * ## Why the fallback is Playwright's, and why it is full depth
 *
 * Because the compiler is the newest code in the tree and a page it reads badly
 * must not leave the model blind. Full depth rather than a depth cut, and that
 * was measured rather than chosen: `depth:6` looks like the obvious saving at
 * 8,729 characters, but depth folds controls into their ancestor's accessible
 * name, so on Hacker News the 225 addressable actions collapse to 8 and `login`,
 * `past` and `submit` become unclickable words. A fallback that cannot act is
 * not a fallback.
 *
 * The fallback is expensive by design. It should be rare, and if it fires often
 * that is a compiler bug to fix rather than a path to make comfortable.
 */

import type { Page } from "playwright";

import { collectPage, type CollectedPage } from "./collect.js";
import { compileCollected } from "./ir-tree.js";
import type { BrowserIR } from "./ir.js";
import { renderModelView } from "./model-view.js";

/** Why the compiler's own view was not used. */
export type FallbackReason = "collect-failed" | "compile-failed" | "no-sections" | "requested";

export interface PerceptionResult {
  /** What the model reads. */
  text: string;
  /** The compiled page, when the compile produced one. Absent on a fallback. */
  ir: BrowserIR | undefined;
  /** True when the text is Playwright's snapshot rather than the compiled view. */
  usedFallback: boolean;
  /** Why, when it was. */
  fallbackReason: FallbackReason | undefined;
  /** The line the observation header carries, so a fallback announces itself. */
  note: string | undefined;
  /** How many addressable elements the view carries, for the stats line. */
  elementCount: number;
  /** How many sections the compiled view describes. Zero on a fallback. */
  sectionCount: number;
}

export interface PerceiveOptions {
  /** The previous compile, so ids and section ids stay stable across revisions. */
  previous?: BrowserIR | undefined;
  /** What the model is doing, for relevance ranking. */
  context?: { step?: string | undefined; goal?: string | undefined; blockers?: string[] | undefined } | undefined;
  /**
   * Read Playwright's own snapshot instead of compiling.
   *
   * The escape hatch, and it is deliberately reachable without a code change:
   * on a page the compiler reads badly, a caller can ask for the tree the
   * browser itself would describe and see what the difference is. It is also
   * what `depth` scopes, since a depth cut is a property of that snapshot and
   * not of the compile.
   */
  raw?: boolean | undefined;
  /** Depth for the raw snapshot. Ignored by the compile, which has its own idea. */
  depth?: number | undefined;
  /** The character budget. */
  maxChars?: number | undefined;
  /**
   * The collector, injectable so a test can make it fail.
   *
   * The fallback is the one path that only runs when something is broken, which
   * makes it the path least likely to be exercised and most likely to rot. A
   * seam that lets a test drive it directly is what keeps "the model is never
   * left blind" a checked claim rather than an intention.
   */
  collect?: ((page: Page) => Promise<CollectedPage>) | undefined;
}

/**
 * Read a page as the model should see it.
 *
 * Never throws for a reason the page caused. A collect that fails, a compile
 * that throws and a compile that produces nothing all end at the fallback, and
 * the caller gets text either way. The only errors that escape are the ones
 * where even Playwright's own snapshot failed, which means the page is gone and
 * the caller needs to know that rather than read an empty view.
 */
export async function perceive(page: Page, options: PerceiveOptions = {}): Promise<PerceptionResult> {
  if (options.raw === true) {
    const text = await page.ariaSnapshot({
      mode: "ai",
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    });
    return {
      text,
      ir: undefined,
      usedFallback: true,
      fallbackReason: "requested",
      note: "RAW: this is Playwright's own accessibility snapshot, requested explicitly. Elements are addressed by aria-ref=N.",
      elementCount: 0,
      sectionCount: 0,
    };
  }

  const collect = options.collect ?? ((target: Page) => collectPage(target));

  let collected: CollectedPage;
  try {
    collected = await collect(page);
  } catch (error) {
    return fallback(page, "collect-failed", reasonOf(error), options);
  }

  let ir: BrowserIR;
  try {
    ir = compileCollected(collected, {
      ...(options.previous !== undefined ? { previous: options.previous } : {}),
      ...(options.context !== undefined
        ? {
            context: {
              ...(options.context.step !== undefined ? { step: options.context.step } : {}),
              ...(options.context.goal !== undefined ? { goal: options.context.goal } : {}),
              ...(options.context.blockers !== undefined ? { blockers: options.context.blockers } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    return fallback(page, "compile-failed", reasonOf(error), options);
  }

  /*
   * A compile with no sections is treated as a failed read rather than an empty
   * page, and the fallback is what decides between them.
   *
   * That is deliberate. The IR can say a page was not read, but it cannot prove
   * a page is empty: an empty compile is the same output either way, and the
   * two call for opposite actions. Playwright's snapshot is the second opinion
   * that settles it, and when the page really is bare the snapshot says so in a
   * handful of characters. The alternative is trusting a zero, which is the
   * silent-coverage failure this whole layer exists to prevent.
   */
  if (ir.sections.length === 0) {
    const because = ir.coverage.complete ? "the compiler found no sections" : (ir.coverage.incompleteBecause ?? "the page was not read");
    return fallback(page, "no-sections", because, options);
  }

  const view = renderModelView(ir, {
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
    context: {
      ...(options.context?.step !== undefined ? { step: options.context.step } : {}),
      ...(options.context?.goal !== undefined ? { goal: options.context.goal } : {}),
      ...(options.context?.blockers !== undefined ? { blockers: options.context.blockers } : {}),
    },
  });

  return {
    text: view.text,
    ir,
    usedFallback: false,
    fallbackReason: undefined,
    note: undefined,
    elementCount: ir.elements.size,
    sectionCount: ir.sections.length,
  };
}

/**
 * Playwright's own view of the page, announced as a fallback.
 *
 * The note is not decoration. The two representations address elements
 * differently: the compiled view hands out `s1:r3` and locator expressions,
 * where the snapshot hands out `aria-ref=e74`. A model that reads a fallback
 * believing it is a compile will write a locator that resolves to nothing, and
 * the failure will look like the page being wrong.
 */
async function fallback(page: Page, reason: FallbackReason, because: string, options: PerceiveOptions): Promise<PerceptionResult> {
  const text = await page.ariaSnapshot({
    mode: "ai",
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
  });
  return {
    text,
    ir: undefined,
    usedFallback: true,
    fallbackReason: reason,
    note:
      `FALLBACK (${reason}): the page compiler could not read this page (${because}), so this is Playwright's own ` +
      `accessibility snapshot instead of the compiled view. It has no section or row ids: address elements by ` +
      `aria-ref=N with page.locator("aria-ref=e74"), not by locator expressions.`,
    elementCount: 0,
    sectionCount: 0,
  };
}

/** The first line of an error, which is the part that says what happened. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "unknown error";
}
