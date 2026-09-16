/**
 * What the agent did, in a sentence.
 *
 * A session log that says `## tool browser_use t3 1200ms` tells a reader nothing
 * about the browsing it recorded. Reading back a session should answer "what did
 * the agent actually do on this page" without parsing a program, so the tool's
 * own receipt is turned into one line here.
 *
 * This is deliberately not a summary of the *code*. The program's text is
 * already in the log, verbatim, and paraphrasing it would be a second
 * interpretation that can disagree with the first. What the receipt adds and the
 * code cannot is the outcome: that the click navigated, that it changed nothing,
 * that the page had moved on.
 *
 * Written for a person reading the session later, which is why it names the
 * outcome in words rather than repeating the enum.
 */

import type { StepReceipt } from "../browser/transaction.js";

/** The fields of a `browser_use` result this reads. Structural, not imported. */
interface BrowserUseLogOutput {
  outcome?: string;
  rev?: number;
  surface?: { url?: string; title?: string } | undefined;
}

/**
 * One line describing a browser step, or undefined when this is not one.
 *
 * Returning undefined for everything else is the contract: a caller can use this
 * to decorate every tool call without knowing which tools it understands.
 */
export function summariseBrowserAction(toolName: string, output: unknown): string | undefined {
  if (toolName !== "browser_use") return undefined;
  const result = asRecord(output);
  if (!result) return undefined;

  const outcome = typeof result.outcome === "string" ? result.outcome : undefined;
  if (outcome === undefined) return undefined;

  const surface = asRecord(result.surface);
  const where = typeof surface?.url === "string" && surface.url.length > 0 ? ` on ${surface.url}` : "";
  const heading = typeof surface?.title === "string" && surface.title.length > 0 ? ` (${surface.title})` : "";

  /*
   * The outcome phrased as a fact about the page rather than as a status code.
   *
   * `NO_CHANGE` is the one that most needs a sentence: a reader skimming a
   * session sees a click that achieved nothing, and "the page did not change"
   * says whether that was expected. The others map to what a person would say.
   */
  switch (outcome) {
    case "SUCCESS":
      return `browsed${where}${heading}`;
    case "NO_CHANGE":
      return `acted${where}, and the page did not change`;
    case "STALE_REVISION":
      return `refused to act${where}: the page had changed since it was last read`;
    case "PRECONDITION_FAILED":
      return `could not run the program against ${where}`;
    case "POSTCONDITION_FAILED":
      return `the action failed${where}`;
    case "TIMEOUT":
      return `the program was still running when it was cut off${where}`;
    case "BROWSER_DISCONNECTED":
      return `the page was closed or the browser went away${where}`;
    case "PARTIAL_COVERAGE":
      return `read part of ${where}: some content could not be read`;
    default:
      return `browsed${where}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The same line for a receipt the caller already has.
 *
 * The executor holds the tool's result rather than a receipt, so
 * `summariseBrowserAction` is what it uses. This exists for the places that do
 * have a receipt, so the two cannot drift into two vocabularies for the same
 * event.
 */
export function summariseReceipt(receipt: StepReceipt): string {
  const where = receipt.urlAfter.length > 0 ? ` on ${receipt.urlAfter}` : "";
  if (receipt.outcome === "SUCCESS" && receipt.navigated) return `browsed${where}: the page navigated`;
  return summariseBrowserAction("browser_use", { outcome: receipt.outcome, surface: { url: receipt.urlAfter } }) ?? `browsed${where}`;
}
