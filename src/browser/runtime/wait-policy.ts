/**
 * Timeouts, chosen per operation rather than inherited from one global.
 *
 * Playwright's default action timeout is 30 seconds, and a model that leaves it
 * alone pays it on every failure. Measured on one mission: fourteen failed
 * browser calls, of which several were full 30-second waits, and the failed
 * calls alone accounted for over eleven minutes of a fifty-five-minute run. The
 * model was not slow. It was waiting, repeatedly, for something that was never
 * going to happen, and the wait was long enough that it could not tell the
 * difference between "this element is not here" and "this page is slow".
 *
 * A single short default would fix the eleven minutes and break the slow sites,
 * so the budgets are named instead of global. The distinction that matters is
 * between an operation where the element should already exist and the page is
 * simply telling us it does not, and one where the site is genuinely slow and a
 * longer wait is the correct behaviour rather than a hang.
 *
 * The budgets are deliberately not a ceiling on the program. A model that knows
 * better can pass its own, and `step()` still bounds the whole program, so a
 * wrong choice here costs a slower answer rather than a stuck turn.
 */

/** What an operation is, which is what decides its budget. */
export type OperationKind =
  /** A locator action on an element that should already be on the page. */
  | "locator"
  /** A postcondition check: did the thing we just did have the effect we meant. */
  | "assertion"
  /** Looking for an element whose existence is not yet established. */
  | "discovery"
  /** An ordinary page load or navigation. */
  | "navigation"
  /** Waiting for a popup or a download the page has to raise. */
  | "event"
  /** A known slow endpoint: a search, a report, a redirect chain. */
  | "slowAjax";

/**
 * The budgets, in milliseconds.
 *
 * Chosen from what the operation actually involves rather than spread evenly.
 * A locator action on a page the model has just read should be near-instant:
 * four seconds is already generous for a browser that is not fighting a slow
 * network, and it is short enough that a wrong locator is discovered in a
 * fraction of a turn rather than a fifth of one.
 *
 * Discovery gets a little more because the model is asking "is this here yet"
 * about something it has reason to believe exists. Navigation and events get
 * the most because they are the two operations that genuinely wait on a remote
 * machine.
 */
export const WAIT_BUDGETS: Record<OperationKind, number> = {
  locator: 4_000,
  assertion: 5_000,
  discovery: 5_000,
  navigation: 15_000,
  event: 15_000,
  slowAjax: 15_000,
};

/**
 * The word that names a budget in code the model writes.
 *
 * `page.getByRole(...).click({ timeout: 4_000 })` is what these resolve to. The
 * names exist so a model does not have to remember a number per call site, and
 * so a budget can be corrected in one place rather than in every program that
 * copied it.
 */
export const WAIT_NAMES: Record<string, OperationKind> = {
  locator: "locator",
  assertion: "assertion",
  discovery: "discovery",
  navigation: "navigation",
  event: "event",
  slow: "slowAjax",
};

/** Resolve a named or numeric budget, with a fallback kind for a bare number. */
export function resolveBudget(value: unknown, fallback: OperationKind): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const kind = WAIT_NAMES[value.toLowerCase()];
    if (kind !== undefined) return WAIT_BUDGETS[kind];
  }
  return WAIT_BUDGETS[fallback];
}

/**
 * Find fixed sleeps in a program.
 *
 * `page.waitForTimeout(3000)` is the single most expensive line a model writes,
 * and one mission contained forty-four of them. Each is a guess: the model does
 * not know how long the thing takes, so it picks a number that felt safe, and
 * the number is wrong in both directions at once. Too short on a slow run and
 * the next line reads a half-rendered page; too long and every step in a
 * hundred-step task pays it.
 *
 * Playwright's own guidance is not subtle: never wait for a timeout in
 * production, wait for the condition. So this reports them rather than banning
 * them. A warning that says which line and what to wait for instead teaches the
 * model something it will use in the next program; a build error would just
 * cost it a turn and it would reach for `evaluate` with a sleep instead.
 *
 * A short sleep is not flagged. There are real cases, debounce and animation
 * being the two, where waiting a fraction of a second for a specific reason is
 * the correct code rather than a guess, and a check that flags those is one the
 * model learns to ignore.
 */
export const FIXED_SLEEP_THRESHOLD_MS = 500;

export interface FixedSleepWarning {
  /** The whole call as it appears in the source. */
  call: string;
  /** How long it sleeps, when the argument is a literal. */
  ms?: number;
  /** What to wait for instead, chosen from the call's own surroundings. */
  instead: string;
}

export function findFixedSleeps(code: string): FixedSleepWarning[] {
  const warnings: FixedSleepWarning[] = [];
  /*
   * Matches `waitForTimeout(n)` and `sleep(n)`, with the number captured. Both
   * spellings reach the same place in Playwright's API, and a model that has
   * been told the first is discouraged will write the second.
   */
  const pattern = /(?:waitForTimeout|sleep)\s*\(\s*(\d[\d_]*)\s*\)/g;
  for (const match of code.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const ms = Number(raw.replace(/_/g, ""));
    if (!Number.isFinite(ms) || ms < FIXED_SLEEP_THRESHOLD_MS) continue;
    warnings.push({
      call: match[0],
      ms,
      instead:
        "wait for the condition itself: `await expect(locator).toBeVisible()`, `await page.waitForURL(...)`, " +
        "`await page.waitForSelector(...)`, or `await browser.waitForChange()` when you want whatever the click caused.",
    });
  }
  return warnings;
}

/** One block for the receipt, or an empty string when there were none. */
export function renderSleepWarnings(warnings: FixedSleepWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = [
    `SLOW: ${warnings.length} fixed ${warnings.length === 1 ? "sleep" : "sleeps"} in this program, which is a guess about how long the page takes.`,
  ];
  for (const warning of warnings) {
    lines.push(`  ${warning.call}${warning.ms !== undefined ? ` (${warning.ms}ms)` : ""} -> ${warning.instead}`);
  }
  return lines.join("\n");
}
