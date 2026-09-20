/**
 * Turning a Playwright exception into a fact the model can act on.
 *
 * The problem this solves is measured rather than theorised. A mission spent
 * eleven of its fifty-five minutes inside failed browser calls, and the reason
 * is what it was handed when one failed: Playwright's own message, which is a
 * call log describing how it waited. That log is written for a human debugging
 * a test, and it is the wrong shape for a model choosing its next move. It says
 * "Timeout 30000ms exceeded" whether the element never existed, existed and was
 * covered, existed and was disabled, or existed and was detached mid-click.
 * Those four want four different next actions and the log does not distinguish
 * them.
 *
 * So every failure is classified into a closed set, and the set is closed for
 * the same reason `StepOutcome` is: the model's next move depends on which one
 * it is, and an open set means it has to infer rather than read. Each kind
 * carries the three things a next move needs:
 *
 *   retryable        whether repeating the same action is worth trying
 *   diagnostic       one sentence naming the mechanism, not the symptom
 *   recommendedNext  what to do instead, when repeating is not it
 *
 * Nothing here calls the browser. It is a pure function over an error plus the
 * optional geometry of the target, which is what makes it testable against the
 * exact strings Playwright produces rather than against a live page.
 */

/**
 * The taxonomy.
 *
 * Modelled on Playwright's own actionability checks, because those are the
 * conditions it actually tests and therefore the conditions that actually
 * produce failures. A kind that Playwright cannot report would be a guess about
 * the world; every one below is reachable.
 */
export type BrowserFailureKind =
  /*
   * The runtime's own refusals, which are not Playwright errors at all.
   *
   * These fell through to `UNKNOWN` with "look at the page and try a different
   * approach", which is useless advice for a mistake the runtime named
   * precisely. Measured on a mission: ten receipts that said `FAILURE: UNKNOWN`
   * for errors whose own messages were exact (`no open page named "p8"`,
   * `subtask status must be one of ...`). The model was told to look at the page
   * when the answer was in the sentence it had just read.
   */
  | "PAGE_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "MISSING_AWAIT"
  | "LOCATOR_NOT_FOUND"
  | "LOCATOR_AMBIGUOUS"
  | "NOT_VISIBLE"
  | "ZERO_AREA"
  | "NOT_ENABLED"
  | "NOT_EDITABLE"
  | "NOT_RECEIVING_EVENTS"
  | "DETACHED"
  | "NAVIGATION_TIMEOUT"
  | "ACTION_TIMEOUT"
  | "PAGE_CLOSED"
  | "PAGE_CRASHED"
  | "RENDERER_UNRESPONSIVE"
  | "POPUP_NOT_CREATED"
  | "DOWNLOAD_FAILED"
  | "POSTCONDITION_FAILED"
  | "FORM_VALIDATION"
  | "SERVER_REJECTION"
  | "POLICY_VIOLATION"
  | "UNKNOWN";

export interface BrowserFailure {
  kind: BrowserFailureKind;
  /** The locator or URL the failure is about, when the error names one. */
  target?: string;
  /** One sentence naming the mechanism. Not Playwright's call log. */
  diagnostic: string;
  /** Whether doing the same thing again is a reasonable next move. */
  retryable: boolean;
  /** What to do instead, when repeating is not it. */
  recommendedNext?: string;
}

/**
 * Classify a Playwright error.
 *
 * Ordered, not a lookup, because the messages are not exclusive: an ambiguous
 * locator reports "strict mode violation" *and* a timeout, and a detached
 * element reports "not attached" inside a click timeout. The most specific
 * condition is tested first, which is why this reads as a priority list rather
 * than a table.
 *
 * `geometry` is the target's bounding box when the caller has it. It is what
 * separates `ZERO_AREA` from `NOT_VISIBLE`: Playwright reports a zero-size
 * element as "not visible", which is true but useless, because the fix for a
 * hidden element and the fix for a zero-width one are different.
 */
export function classifyFailure(
  error: unknown,
  geometry?: { width: number; height: number } | undefined,
): BrowserFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.split("\n")[0] ?? raw;
  const lower = raw.toLowerCase();
  const target = extractTarget(raw);

  /*
   * A closed page first, because its message contains words the other branches
   * also match ("closed" appears inside several timeouts) and it is the one
   * failure where retrying is guaranteed to fail again.
   */
  if (/target (page|closed)|has been closed|browser has been closed|context or browser has been closed/.test(lower)) {
    return {
      kind: "PAGE_CLOSED",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The page was closed, so the action could not be dispatched.",
      retryable: false,
      recommendedNext: "Open a page with browser.newPage() and continue there, or switch to a tab that is still open.",
    };
  }
  if (/target crashed|page crashed/.test(lower)) {
    return {
      kind: "PAGE_CRASHED",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The page's renderer process crashed.",
      retryable: false,
      recommendedNext: "Call recover() to replace the renderer, then reload the page.",
    };
  }

  /*
   * The runtime's own errors, checked before Playwright's.
   *
   * These are the sentences this codebase writes, and they are exact: they name
   * the page, the argument, or the missing await. Falling through to UNKNOWN
   * threw that away and replaced it with "look at the page", which on a mission
   * is what ten receipts did.
   */
  if (/no open page named|does not resolve to a page|that page is closed/.test(lower)) {
    return {
      kind: "PAGE_NOT_FOUND",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The page this program named is not open, so there was nothing to drive.",
      retryable: false,
      recommendedNext: "List the open pages and use a name or id from that list; `browser.pages()` shows them with their names.",
    };
  }
  /*
   * Either shape of the missing-await mistake: the sandbox's own sentence
   * ("returns a Promise, so its result needs `await`") or JavaScript's own
   * "x is not a function" when something calls a method on a promise. The second
   * needs the word "await" or "promise" alongside it, because "is not a
   * function" on its own is a hundred different mistakes and guessing at this
   * one would mislabel them.
   */
  if (/returns a promise.*needs .?await|needs .?await/i.test(message) || (/is not a function/.test(lower) && /await|promise/i.test(message))) {
    /*
     * The missing-await trap, which now explains itself in the sandbox. This
     * branch catches the same mistake reaching here through another path, and
     * keeps the classification honest rather than reporting UNKNOWN for a
     * mistake with a known cause and a known fix.
     */
    return {
      kind: "MISSING_AWAIT",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "A method was called on something that is a Promise, which usually means a missing `await`.",
      retryable: false,
      recommendedNext: "Add the `await`: `const x = await list.find(async (p) => ...)` and then call the method on `x`.",
    };
  }
  if (/must be one of|is required|expected a|needs a |takes the/.test(lower)) {
    return {
      kind: "INVALID_ARGUMENT",
      ...(target !== undefined ? { target } : {}),
      diagnostic: message,
      retryable: false,
      recommendedNext: "Call it with the shape the message names. The page is fine; only the argument was wrong.",
    };
  }

  if (/strict mode violation|resolved to \d+ elements/.test(lower)) {
    return {
      kind: "LOCATOR_AMBIGUOUS",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The locator matched more than one element, so Playwright refused to guess which.",
      retryable: false,
      recommendedNext: "Narrow the locator until it matches one element, for example with .first(), .nth(n), or a filter.",
    };
  }

  /*
   * Zero area before the generic not-visible branch, and only when geometry was
   * supplied. Without a box this cannot be told from any other invisibility, and
   * guessing ZERO_AREA from the message alone would be wrong for a display:none
   * element that also has no box.
   */
  if (geometry !== undefined && (geometry.width === 0 || geometry.height === 0)) {
    return {
      kind: "ZERO_AREA",
      ...(target !== undefined ? { target } : {}),
      diagnostic: `The element has a ${geometry.width}x${geometry.height} box, so nothing can be hit inside it.`,
      retryable: false,
      recommendedNext: "Click a child or an adjacent element that has a real box, or call inspect() to see what is inside.",
    };
  }

  /*
   * The four actionability verdicts Playwright reports by name. Each is a
   * condition of the element rather than of the page, and each has exactly one
   * sensible response.
   */
  if (/element is not enabled|not enabled/.test(lower)) {
    return {
      kind: "NOT_ENABLED",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The element is present but disabled.",
      retryable: false,
      recommendedNext: "Fill whatever the form requires first, or wait for the control to become enabled and try again.",
    };
  }
  if (/element is not editable|not editable/.test(lower)) {
    return {
      kind: "NOT_EDITABLE",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The element exists but is not an input the browser will accept text into.",
      retryable: false,
      recommendedNext: "Target the actual input, select or textarea rather than its label or container.",
    };
  }
  if (/does not receive pointer events|intercepts pointer events|element is not receiving/.test(lower)) {
    return {
      kind: "NOT_RECEIVING_EVENTS",
      ...(target !== undefined ? { target } : {}),
      /*
       * This one is usually a dialog, a cookie banner or a transition, so it is
       * the one actionability failure worth one retry: the obstruction is
       * frequently transient and waiting for actionability resolves it. That is
       * exactly what Playwright already does internally, which is why seeing
       * this message means the obstruction outlasted Playwright's own retry.
       */
      diagnostic: "Something else is on top of the element, so the click landed on the obstruction.",
      retryable: true,
      recommendedNext: "Dismiss whatever is covering the page, then retry. inspect() names the covering element.",
    };
  }
  if (/element is not visible|not visible/.test(lower)) {
    return {
      kind: "NOT_VISIBLE",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The element is in the DOM but has no visible box, so it cannot be clicked or filled.",
      retryable: false,
      recommendedNext: "Reveal it first (open the menu, expand the section), or target the element that is actually rendered.",
    };
  }
  if (/not attached to the dom|element is not attached|detached/.test(lower)) {
    return {
      kind: "DETACHED",
      ...(target !== undefined ? { target } : {}),
      /*
       * Detached is the one condition a plain retry genuinely fixes: the page
       * re-rendered under the action, and the same locator resolves again a
       * moment later. It is bounded to one retry by the recovery controller,
       * because a list that re-renders on every click would otherwise loop.
       */
      diagnostic: "The element was re-rendered between resolving it and acting on it.",
      retryable: true,
      recommendedNext: "Retry once; the locator should resolve against the new render.",
    };
  }

  if (/no element found|cannot find element|waiting for (locator|selector)/.test(lower) && /timeout/.test(lower)) {
    return {
      kind: "LOCATOR_NOT_FOUND",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The locator matched nothing for the whole wait.",
      retryable: false,
      recommendedNext: "Look at the page again and re-derive the locator from what is actually there.",
    };
  }

  if (/navigation|net::err_|ns_error_|err_connection|err_name_not_resolved/.test(lower)) {
    return {
      kind: "NAVIGATION_TIMEOUT",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The navigation did not complete in time or the host could not be reached.",
      retryable: true,
      recommendedNext: "Retry once; if it fails again the site is unreachable, so try another route or another site.",
    };
  }

  /*
   * A download that went wrong, including the case where the file arrived and
   * could not be *copied*.
   *
   * "it could not be copied into this thread's vault" is our own sentence, and it
   * names neither a failure nor an error nor a cancellation, so it reached the
   * fallback and was reported as `UNKNOWN`. Measured: a live integration run
   * failed the download test with `FAILURE: UNKNOWN` and a perfectly explicit
   * message underneath it, which is the shape this classifier exists to remove.
   * `ENOENT` and `copyfile` are named as well, because the underlying errno is
   * what a raw Playwright error carries.
   */
  if (
    (/download/.test(lower) && /(fail|error|cancel)/.test(lower)) ||
    /could not be copied into this thread's vault|enoent.*copyfile|copyfile.*enoent/.test(lower)
  ) {
    return {
      kind: "DOWNLOAD_FAILED",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The download was triggered but did not produce a file this thread could keep.",
      retryable: true,
      recommendedNext: "Use browser.download() so the wait is armed before the click, and retry once.",
    };
  }

  if (/timeout \d+ms exceeded|exceeded.*timeout/.test(lower)) {
    return {
      kind: "ACTION_TIMEOUT",
      ...(target !== undefined ? { target } : {}),
      diagnostic: "The action waited for the element to become actionable and it never did.",
      retryable: false,
      recommendedNext: "Call inspect() on the target to learn which actionability check it failed.",
    };
  }

  return {
    kind: "UNKNOWN",
    ...(target !== undefined ? { target } : {}),
    diagnostic: message,
    retryable: false,
    recommendedNext: "Look at the page and try a different approach.",
  };
}

/**
 * The locator or URL an error names, when it names one.
 *
 * Best effort and deliberately narrow: a wrong target is worse than no target,
 * because the model will act on it. Only the two shapes Playwright reliably
 * prints are read, the `locator('...')` call and a bare URL.
 */
function extractTarget(message: string): string | undefined {
  const locator = /locator\((['"])(.+?)\1\)/.exec(message);
  if (locator?.[2]) return locator[2].slice(0, 200);
  const getBy = /(getBy[A-Za-z]+\([^)]*\))/.exec(message);
  if (getBy?.[1]) return getBy[1].slice(0, 200);
  const url = /(https?:\/\/[^\s'")]+)/.exec(message);
  if (url?.[1]) return url[1].slice(0, 200);
  return undefined;
}

/**
 * The failure as the model reads it.
 *
 * One block, and it is deliberately small. The measured failure this replaces
 * was Playwright's call log, which is a dozen lines describing the wait, and
 * which the model spent turns decoding. The packet carries the verdict, the
 * target, the reason, and what to do, in that order, and nothing else.
 */
export function renderFailure(failure: BrowserFailure): string {
  const lines = [`FAILURE: ${failure.kind}`];
  if (failure.target !== undefined) lines.push(`TARGET: ${failure.target}`);
  lines.push(`REASON: ${failure.diagnostic}`);
  lines.push(`RETRYABLE: ${failure.retryable ? "yes" : "no"}`);
  if (failure.recommendedNext !== undefined) lines.push(`NEXT: ${failure.recommendedNext}`);
  return lines.join("\n");
}
