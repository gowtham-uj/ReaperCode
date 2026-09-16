/**
 * Did the step do what it said it would?
 *
 * The receipt already answers a weaker question: what changed. A verifier
 * answers the one that matters to a task: whether the change is the one that was
 * wanted. Those come apart in ways that cost a whole task, and the cheap
 * checks catch most of them.
 *
 * ## The ladder, and why it is a ladder
 *
 * **Level 0, free, always runs.** Structural facts that need no interpretation:
 * did the page change at all, did it navigate, did the outline go from having a
 * form to having none, did an error appear. These are pure comparisons and they
 * are where the majority of real failures are caught, because a browser failure
 * is usually a step that did nothing rather than a step that did something
 * subtle and wrong.
 *
 * **Level 1, cheap, always runs.** The model states what it expected before
 * acting, and the check is whether the page now says it. `expect: { urlIncludes:
 * "/dashboard" }`, `expect: { textPresent: "Signed in" }`. This costs one
 * string comparison and catches the case level 0 cannot: the page changed, but
 * not to the thing that was wanted.
 *
 * **Levels 2 and 3, behind an interface, not built.** Level 2 is a model call
 * asking "does this page satisfy this goal", and level 3 is a reward model. Both
 * are real and neither is worth building before there is evidence about what
 * levels 0 and 1 miss. They sit behind `Verifier2` so a caller can see the seam
 * rather than discovering it.
 *
 * ## What this deliberately does not do
 *
 * It does not decide whether the *task* is complete. A verifier that says "done"
 * is the most dangerous component in an agent, because a model that trusts it
 * stops. Everything here reports evidence and a verdict; nothing here decides
 * that the job is finished.
 */

import type { StepReceipt } from "./transaction.js";

/** What the model said it expected to happen. */
export interface StepExpectation {
  /** The URL must contain this, after the step. */
  urlIncludes?: string | undefined;
  /** The URL must be different from before. */
  urlChanged?: boolean | undefined;
  /** This text must appear somewhere in the page outline. */
  textPresent?: string | undefined;
  /** This text must be gone from the page outline. */
  textAbsent?: string | undefined;
  /** The page outline must have changed at all. */
  pageChanged?: boolean | undefined;
  /** An error, alert or validation message must be present. */
  expectFailure?: boolean | undefined;
}

export interface Verification {
  /** 0 for structural, 1 for a stated expectation. */
  level: 0 | 1;
  passed: boolean;
  /** One line, for the model and the log. */
  note: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: Verification[];
  /**
   * The strongest statement this can make about what happened.
   *
   * Deliberately not "the task is done". It is "nothing contradicted what you
   * said you expected", which is what the evidence supports.
   */
  summary: string;
}

/** Words that mean the page is telling the user something went wrong. */
const FAILURE_MARKERS = ["error", "invalid", "required", "failed", "not found", "denied", "incorrect", "try again", "unable to"];

/**
 * Run the checks that are free.
 *
 * Every one of these is a comparison against the receipt, so this costs nothing
 * and runs on every step. The order is deliberate: the cheapest and most
 * informative findings first, so a failure reports the most specific thing it
 * can rather than a list.
 */
export function verifyStep(receipt: StepReceipt, expectation: StepExpectation | undefined, outline: string): VerificationReport {
  const checks: Verification[] = [];
  const changed = receipt.outcome !== "NO_CHANGE";

  /* ---- Level 0: facts about the step itself ---- */

  if (expectation?.pageChanged === true && !changed) {
    checks.push({ level: 0, passed: false, note: "the page did not change, and the step expected it to" });
  }
  if (expectation?.urlChanged === true && !receipt.navigated) {
    checks.push({ level: 0, passed: false, note: "the page did not navigate, and the step expected it to" });
  }

  /*
   * An error on the page when none was expected is worth reporting even when
   * the step "worked", because it is the shape of a form submission that was
   * rejected after a successful click. A model told only SUCCESS would move on.
   */
  const failureText = findFailureMarker(outline);
  if (failureText !== undefined && expectation?.expectFailure !== true && receipt.outcome === "SUCCESS") {
    checks.push({
      level: 0,
      passed: false,
      note: `the page shows "${failureText}", which usually means the action was rejected even though it ran`,
    });
  }

  /* ---- Level 1: the stated expectation ---- */

  if (expectation?.urlIncludes !== undefined) {
    const present = receipt.urlAfter.includes(expectation.urlIncludes);
    checks.push({
      level: 1,
      passed: present,
      note: present
        ? `the url contains "${expectation.urlIncludes}" as expected`
        : `the url is ${receipt.urlAfter}, which does not contain "${expectation.urlIncludes}"`,
    });
  }

  if (expectation?.textPresent !== undefined) {
    const present = outline.toLowerCase().includes(expectation.textPresent.toLowerCase());
    checks.push({
      level: 1,
      passed: present,
      note: present
        ? `"${expectation.textPresent}" is on the page as expected`
        : `"${expectation.textPresent}" is not on the page`,
    });
  }

  if (expectation?.textAbsent !== undefined) {
    const gone = !outline.toLowerCase().includes(expectation.textAbsent.toLowerCase());
    checks.push({
      level: 1,
      passed: gone,
      note: gone ? `"${expectation.textAbsent}" is gone as expected` : `"${expectation.textAbsent}" is still on the page`,
    });
  }

  if (expectation?.expectFailure === true) {
    const failed = failureText !== undefined;
    checks.push({
      level: 1,
      passed: failed,
      note: failed ? `the page reports "${failureText}" as expected` : "an error was expected and the page shows none",
    });
  }

  const failed = checks.filter((check) => !check.passed);
  return {
    passed: failed.length === 0,
    checks,
    summary:
      failed.length === 0
        ? checks.length === 0
          ? "the step ran and nothing contradicted it"
          : `${checks.length} check${checks.length === 1 ? "" : "s"} passed`
        : `${failed.length} of ${checks.length} checks failed: ${failed.map((check) => check.note).join("; ")}`,
  };
}

/**
 * The first failure marker the page is showing, if any.
 *
 * Searched in the outline rather than in the DOM because the outline is what the
 * model was shown, and a verifier that disagrees with the model's own view is a
 * verifier that reports things the model cannot see.
 *
 * Deliberately crude. A real error classifier is a model call, which is level 2,
 * and this is the free approximation that catches the common case.
 */
function findFailureMarker(outline: string): string | undefined {
  const lines = outline.split("\n");
  for (const line of lines) {
    /*
     * Only text the page is showing as content, so a button labelled "Retry"
     * and a URL containing "error" do not count. Alert and status roles are
     * where a site announces a rejection.
     */
    const match = /- (alert|status)\s+"([^"]{1,80})"/i.exec(line);
    if (match) return match[2]!.trim();
  }
  /*
   * Then named elements, and only where the name is a short message rather than
   * prose. The first version scanned every line for any marker word, which
   * reported a page containing "Read the error handling guide" as an error, and
   * a check that fires on ordinary text is a check that gets ignored.
   */
  for (const line of lines) {
    if (!/^(?:\s*)- /.test(line)) continue;
    const name = /"([^"]{1,80})"/.exec(line)?.[1];
    if (name === undefined) continue;
    const trimmed = name.trim();
    /*
     * A sentence is prose, not a message. Real validation text is short and
     * direct ("Email is required"), where documentation and body copy are not.
     */
    if (trimmed.length > 60 || /\s(and|or|the|a|to|for)\s/i.test(trimmed.slice(0, 30))) continue;
    const lower = trimmed.toLowerCase();
    if (FAILURE_MARKERS.some((marker) => lower.includes(marker))) return trimmed;
  }
  return undefined;
}
