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
  /**
   * How long the snapshot may take before it is reported as unreadable.
   *
   * Explicit so a wedged page costs seconds rather than the context default's
   * thirty, which the model paid on every call while it was trapped.
   */
  timeoutMs?: number | undefined;
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
   * The text form, and this was measured back after a change to the JSON one
   * turned out to be a regression that reached a release candidate.
   *
   * Playwright 1.63 offers the same tree two ways, and the JSON form is the one
   * the *scoped* read uses (`observe-ladder.ts`), where its per-element geometry
   * is what answers "why can I not click this". This is the whole-page path, and
   * there the geometry buys nothing while the serialisation actively costs:
   *
   *   /basic        text 1378 chars, 24 refs   |  json 1663 chars, 24 refs
   *   /form-limits  text 1182 chars, 21 refs   |  json 1416 chars, 21 refs
   *
   * Same refs, both resolving through `page.locator("aria-ref=e1")`, and 17 to
   * 20 percent larger as JSON because every key is quoted and repeated. On a real
   * page that is tens of thousands of characters of punctuation, paid on every
   * look, to carry boxes the model did not ask for.
   *
   * It also broke `statsOf`, which counts `[ref=...]` markers in the text: the
   * JSON form has none, so `view.stats.refs` and `interactive` reported zero on
   * every page. That is the failure mode worth remembering. A wrong number here
   * does not read as an error, it reads as "this page has nothing on it", and it
   * was caught by an integration test asserting the count rather than by anyone
   * looking at a page.
   *
   * Depth is still not passed. See the note above: depth folds controls into their
   * ancestor's accessible name, so a page that looks complete stops being
   * actionable.
   */
  /*
   * Bounded, and it must not throw for a reason the page caused.
   *
   * ## The deadlock this fixes, measured
   *
   * A page stuck in `document.readyState === "loading"` with no `<body>` (a
   * response that stalled mid-stream) makes `ariaSnapshot` wait for a tree that
   * will never exist. Every mode and every timeout hung; `title()`, `evaluate()`
   * and `locator()` all answered in milliseconds, so the page was otherwise alive.
   *
   * Because this had no catch and the tool's look path has no try around it, the
   * hang threw out of the tool, so *no program ran*, so the active page never
   * changed, so every later call hit the same page. The model was permanently
   * trapped, and its own transcript shows it working that out correctly over
   * seventy calls: the only repair it had was to run code, and every call
   * snapshotted the page before the code.
   *
   * The contract at the top of this file already said "nothing throws for a reason
   * the page caused". A snapshot timeout is exactly that, so it is answered here
   * with a result that says what happened. The model then gets a readable answer
   * and, crucially, code still runs, so it can reload or close the page itself.
   *
   * The timeout is explicit rather than inherited from the context's 30s default,
   * so a wedged page costs seconds per call instead of half a minute. Fifteen
   * seconds is far above a healthy page: the collector measured 359ms on a heavy
   * news site, and the largest fixture page snapshots in well under a second.
   */
  const timeout = options.timeoutMs ?? 15_000;
  let text: string;
  try {
    text = await page.ariaSnapshot({
      mode: "ai",
      timeout,
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    });
  } catch (error) {
    const message = (error as Error).message.split("\n")[0] ?? "the snapshot failed";
    /*
     * A page that is *gone* is not a page that cannot be described, and the two
     * must not be merged.
     *
     * This distinction is load-bearing and a test caught it: the tool has specific
     * handling for a closed page (it opens a replacement and says where, which is
     * Steel's own model of a session), and that handling lives on the throw. The
     * first version of this catch swallowed the closed case too, so the tool never
     * reached its own branch and the model was told "unreadable" about a page that
     * no longer existed.
     *
     * The deadlock was the *other* case: a page that exists and answers reads, but
     * whose snapshot never returns. That case must not throw, because throwing
     * escapes the tool before any program runs. A closed page throws, as it always
     * did, and the caller's existing branch handles it.
     */
    if (/has been closed|Target closed|context or browser has been closed/i.test(message)) throw error;
    /*
     * The page's own state, read with calls that do not need the accessibility
     * tree, so the message can say *why* rather than only that it failed. This is
     * the diagnostic that turns "the tool is broken" into "this tab never
     * finished loading".
     */
    const state = await page
      .evaluate(() => ({ readyState: document.readyState, hasBody: document.body !== null }))
      .catch(() => undefined);
    const loading = state !== undefined && state.readyState !== "complete";
    return {
      text:
        `PAGE UNREADABLE: this page could not be described. ${message}\n` +
        (loading
          ? "The document is still loading and has no body yet, which is what a stalled response leaves behind. " +
            "Its renderer is alive, so you can still run a program on it: reload it with `await page.reload()` or close it and use another tab."
          : "You can still run a program on this page, so try inspecting it from code rather than from a look."),
      ir: undefined,
      usedFallback: true,
      fallbackReason: "collect-failed",
      note: "SNAPSHOT FAILED: the page could not be read. Code you write still runs; the page is the problem, not the sandbox.",
      elementCount: 0,
      sectionCount: 0,
    };
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
