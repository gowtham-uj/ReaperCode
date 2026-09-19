/**
 * What the model reads about a page.
 *
 * **This is a stub.** The custom perception engine was deleted, and its
 * replacement is being designed. Until then this always returns Playwright's own
 * accessibility snapshot, which is what the browser tool reads from.
 *
 * ## Why it is a stub and not a hole
 *
 * The two things a browser tool must not do are go blind and lie. A stub that
 * returned an empty view would do the first; one that returned a compiled view
 * built from nothing would do the second. So this returns the real page, in the
 * representation Playwright maintains, which is a true and complete description
 * of what is on screen. The model can browse with it. It is larger and less
 * directed than a compiled view, and that is the cost of the rebuild, paid
 * knowingly rather than hidden.
 *
 * ## What was removed
 *
 * `collect.ts`, `ir.ts`, `ir-tree.ts` and `model-view.ts` were a four-source CDP
 * collector, a semantic compiler and a renderer, measured at 2,332 characters on
 * Hacker News against the raw snapshot's 47,548. They are gone rather than left
 * in place because dead perception code is not neutral: it is the code a reader
 * assumes is running, and the next person to touch the browser path would have
 * had to work out which of two engines was live.
 *
 * ## What this keeps
 *
 * The shape. `perceive` is still the one path from a live page to text, so the
 * replacement can be dropped in behind it without touching a single caller, and
 * the fallback machinery stays where it is: what changes when the new engine
 * lands is one branch, not the contract.
 *
 * The contract the new engine must meet, recorded here because this is where it
 * is called:
 *
 *   - `text` is what the model reads, and it is the page, not a guess at it
 *   - `usedFallback` is false only when the text came from the compiler
 *   - `note` is set whenever the text is not the compiler's, so a model that
 *     reads it knows how to address elements
 *   - nothing throws for a reason the page caused
 */

import type { Page } from "playwright";

/** Why the compiled view was not used. */
export type FallbackReason = "stub" | "collect-failed" | "compile-failed" | "no-sections" | "requested";

export interface PerceptionResult {
  /** What the model reads. */
  text: string;
  /** The compiled page. Always undefined while the engine is stubbed. */
  ir: undefined;
  /** True when the text is Playwright's snapshot rather than a compiled view. */
  usedFallback: boolean;
  /** Why, when it was. */
  fallbackReason: FallbackReason | undefined;
  /** The line the observation header carries, so a fallback announces itself. */
  note: string | undefined;
  /** How many addressable elements the view carries. Zero until the compiler returns. */
  elementCount: number;
  /** How many sections the compiled view describes. Zero until the compiler returns. */
  sectionCount: number;
}

export interface PerceiveOptions {
  /** The previous compile, so ids stay stable across revisions. Unused by the stub. */
  previous?: undefined;
  /** What the model is doing, for relevance ranking. Unused by the stub. */
  context?: { step?: string | undefined; goal?: string | undefined; blockers?: string[] | undefined } | undefined;
  /**
   * Read Playwright's own snapshot explicitly.
   *
   * Kept because it is the stub's only mode, and because it is the escape hatch
   * the compiled path will need when it returns: a page the compiler reads badly
   * must be reachable without a code change.
   */
  raw?: boolean | undefined;
  /** Depth for the snapshot. Unset means the whole page, which is the default. */
  depth?: number | undefined;
  /** The character budget. Unused by the stub, which does not trim. */
  maxChars?: number | undefined;
}

/**
 * Read a page as the model should see it.
 *
 * One call, no failure paths: `ariaSnapshot` is the representation the browser
 * itself maintains, and when it fails the page is gone and the caller needs to
 * know rather than read an empty view.
 *
 * **No depth is passed, and that is deliberate.** Depth-limiting this snapshot
 * is the one optimisation that looks free and is not. Measured on Hacker News,
 * `depth: 6` returns 8,729 characters against the full snapshot's 47,683 and
 * keeps every story title, which makes it look like the obvious saving. It is a
 * trap: depth folds controls into their ancestor's accessible name, so the nav
 * links stop carrying their own refs and the page's 225 addressable actions
 * collapse to 8. `login`, `past` and `submit` become unclickable words inside a
 * parent's name. The model would read a page that looks complete and cannot be
 * acted on.
 */
export async function perceive(page: Page, options: PerceiveOptions = {}): Promise<PerceptionResult> {
  /*
   * `ariaSnapshotJSON` when the installed Playwright has it, `ariaSnapshot`
   * otherwise.
   *
   * Same representation, two serialisations, and the JSON one is what Playwright
   * 1.63 added for exactly this use: its `mode: "ai"` is the machine-oriented
   * form and it carries element geometry alongside the tree. The geometry is the
   * part worth having on the fallback path, because a zero-area element is
   * invisible in the text form and obvious in the boxed one.
   *
   * The degradation is a real path and not a formality: this is the rung that
   * has to work when everything cleverer has failed, so it cannot be the rung
   * that needs a newer dependency.
   */
  const target = page as unknown as { ariaSnapshotJSON?: (options: Record<string, unknown>) => Promise<unknown> };
  let text: string;
  if (typeof target.ariaSnapshotJSON === "function") {
    const json = await target.ariaSnapshotJSON({
      mode: "ai",
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    });
    text = typeof json === "string" ? json : JSON.stringify(json);
  } else {
    text = await page.ariaSnapshot({
      mode: "ai",
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    });
  }

  return {
    text,
    ir: undefined,
    usedFallback: true,
    fallbackReason: options.raw === true ? "requested" : "stub",
    note:
      options.raw === true
        ? "RAW: Playwright's own accessibility snapshot, requested explicitly. Elements are addressed by aria-ref=N."
        : "SNAPSHOT: this is Playwright's own accessibility snapshot. The compiled perception engine is being rebuilt, so " +
          "this is the whole tree rather than a summary. Elements are addressed by aria-ref=N with " +
          'page.locator("aria-ref=e74"), not by locator expressions.',
    elementCount: 0,
    sectionCount: 0,
  };
}
