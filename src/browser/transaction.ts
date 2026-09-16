/**
 * One browser step, wrapped: capture, act, settle, diff, receipt.
 *
 * The model writes Playwright and this is what runs around it. The reason it is
 * not the model's job is that every part of it is mechanical and every part of
 * it is easy to get subtly wrong: a fixed sleep instead of a settle, a diff
 * against the wrong baseline, a success reported when nothing changed.
 *
 * The loop this implements is the smallest one that is actually useful:
 *
 *     capture revision N
 *       -> run the action
 *       -> wait for the page to stop changing
 *       -> capture revision N+1
 *       -> diff the two
 *       -> say what happened
 *
 * The last line is the one that matters most and the one that is usually
 * missing. A model that clicks a button and is told "ok" has no way to
 * distinguish a page that navigated, a page that showed an error, and a page
 * where the click landed on nothing at all. So the receipt is not "did the
 * call throw" but "what changed", and when nothing changed that is said in
 * those words.
 */

import type { Page } from "playwright";

import type { BrowserIR } from "./ir.js";
import type { PageObserver } from "./page-view.js";

/**
 * The outcomes of one step.
 *
 * Deliberately a closed set, because the model's next move depends on which one
 * it is and an ambiguous result forces it to guess. `NO_CHANGE` in particular
 * has to be its own answer: treating it as success is how an agent clicks
 * Continue six times and reports the task done, and treating it as an error is
 * how an agent gives up on a button that worked and simply did not navigate.
 */
export type StepOutcome =
  | "SUCCESS"
  | "NO_CHANGE"
  | "STALE_REVISION"
  | "PRECONDITION_FAILED"
  | "POSTCONDITION_FAILED"
  | "TIMEOUT"
  | "PARTIAL_COVERAGE"
  | "BROWSER_DISCONNECTED";

export interface StepReceipt {
  outcome: StepOutcome;
  /** The revision the action was taken against. */
  revision: number;
  /** The revision after the page settled. */
  after: number;
  /** True when the page navigated. */
  navigated: boolean;
  /** The URL before and after, so a redirect is visible as one. */
  urlBefore: string;
  urlAfter: string;
  /** The lines that changed, as the model should read them. */
  changes: string;
  /** True when `changes` is the whole outline rather than a delta. */
  wholesale: boolean;
  /** How long the action plus settle took, in milliseconds. */
  elapsedMs: number;
  /**
   * A sentence for the journal and the model.
   *
   * Written as prose because the model reads it and a human reads the session
   * later, and neither wants to parse a status code.
   */
  note: string;
}

/**
 * Wait for the page to stop changing.
 *
 * The naive version of this is a fixed sleep, and it is wrong in both
 * directions: too short on a slow site and the diff reports a half-rendered
 * page, too long and every step in a hundred-step task pays for the slowest one.
 *
 * So the page is polled until the accessibility outline stops changing. That is
 * the right signal for this purpose because it is the same representation the
 * model is shown: an outline that has stopped changing is a page whose readable
 * content has stopped changing, which is exactly the condition under which the
 * diff is meaningful. Network idle is not, and neither is DOM quiet — a page can
 * have both and still be about to render its results.
 *
 * Bounded at both ends. There is a floor because two samples taken a tick apart
 * will agree on a page that is merely between frames, and a ceiling because a
 * spinner or a clock makes some pages never settle, and waiting forever is worse
 * than a diff of a page still in motion.
 */
export interface SettleOptions {
  /** How long two reads must agree before the page counts as settled. */
  quietMs?: number;
  /** The longest to wait, after which the page is read as it is. */
  timeoutMs?: number;
  /** The gap between reads. Smaller is more responsive and costs more CDP calls. */
  pollMs?: number;
}

export const SETTLE_QUIET_MS = 150;
export const SETTLE_TIMEOUT_MS = 5_000;
export const SETTLE_POLL_MS = 60;

export async function settle(page: Page, options: SettleOptions = {}): Promise<{ settled: boolean; outline: string; waitedMs: number }> {
  const quietMs = options.quietMs ?? SETTLE_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? SETTLE_POLL_MS;
  const started = Date.now();

  let previous = await readOutline(page);
  let stableSince = Date.now();

  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(pollMs);
    let current: string;
    try {
      current = await readOutline(page);
    } catch {
      /*
       * A read can fail mid-navigation, when the frame is gone. That is not a
       * settled page and it is not a reason to give up: the next poll reads the
       * page that replaced it.
       */
      continue;
    }
    if (current === previous) {
      if (Date.now() - stableSince >= quietMs) {
        return { settled: true, outline: current, waitedMs: Date.now() - started };
      }
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
  return { settled: false, outline: previous, waitedMs: Date.now() - started };
}

/**
 * One read of the page, in the representation the model is shown.
 *
 * Playwright's own snapshot, because settling is about *stability* rather than
 * about the model's view: it is one CDP call against the compile's four, and it
 * is polled every 60ms. What matters is that two reads of a still page agree,
 * and any faithful representation has that property. The compile is what the
 * model reads; this is what decides the page has stopped moving, and paying four
 * CDP calls per poll to learn the same thing would be the wrong trade.
 *
 * The consequence is that the settled text is not what the observer captures.
 * The settling read is discarded and the page is captured through the runtime's
 * own path afterwards, so the diff the model reads is between two compiled
 * views. Reading the settled text directly would diff a snapshot against a
 * compile and report the whole page as changed.
 */
async function readOutline(page: Page): Promise<string> {
  return page.ariaSnapshot({ mode: "ai" });
}

/**
 * Act, settle, diff, and report.
 *
 * The revision is checked before anything runs. A model holding a revision from
 * before the page changed on its own is about to act on a page it has not seen,
 * and that is the failure the whole revision scheme exists to catch: acting on
 * a stale view is how an agent clicks "Delete" on a row that has been replaced
 * by a different one.
 */
export async function runStep(
  page: Page,
  observer: PageObserver,
  action: () => Promise<unknown>,
  options: {
    expectedRevision?: number | undefined;
    settle?: SettleOptions | undefined;
    before?: BrowserIR | undefined;
    /**
     * How the page is captured into the observer.
     *
     * Injected so the transaction does not decide the representation. The
     * runtime compiles; a test can hand in anything. Without this the two
     * captures in this loop would have to be Playwright snapshots, and the model
     * would read a diff between a snapshot and a compile, which is every line.
     */
    capture?: ((page: Page) => Promise<void>) | undefined;
  } = {},
): Promise<{ receipt: StepReceipt; result: unknown }> {
  const started = Date.now();
  const revision = observer.revision;
  const urlBefore = page.url();

  if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
    return {
      result: undefined,
      receipt: {
        outcome: "STALE_REVISION",
        revision,
        after: revision,
        navigated: false,
        urlBefore,
        urlAfter: urlBefore,
        changes: "",
        wholesale: false,
        elapsedMs: Date.now() - started,
        note:
          `The page is at revision ${revision} and this step was written against revision ${options.expectedRevision}, ` +
          `so the page changed since the model last looked. Look again before acting.`,
      },
    };
  }

  if (page.isClosed()) {
    return {
      result: undefined,
      receipt: {
        outcome: "BROWSER_DISCONNECTED",
        revision,
        after: revision,
        navigated: false,
        urlBefore,
        urlAfter: urlBefore,
        changes: "",
        wholesale: false,
        elapsedMs: Date.now() - started,
        note: "The browser is no longer connected, so the action was not attempted.",
      },
    };
  }

  let result: unknown;
  try {
    result = await action();
  } catch (error) {
    /*
     * An action that throws still leaves a page behind it, and that page is the
     * most useful thing to report. A click that times out because the element is
     * covered by a modal has told the model something real, and re-snapshotting
     * here is what turns a stack trace into "a dialog is in the way".
     */
    const after = await settle(page, options.settle).catch(() => undefined);
    // The settled text is only a signal that the page stopped; the capture is
    // what the model is diffed against, in the runtime's own representation.
    void after;
    await captureInto(options, page, observer);
    const changes = observer.viewChanges();
    return {
      result: undefined,
      receipt: {
        outcome: page.isClosed() ? "BROWSER_DISCONNECTED" : "POSTCONDITION_FAILED",
        revision,
        after: observer.revision,
        navigated: false,
        urlBefore,
        urlAfter: page.url(),
        changes: changes.text,
        wholesale: changes.full,
        elapsedMs: Date.now() - started,
        note: `The action failed: ${(error as Error).message.split("\n")[0] ?? "unknown error"}. The page as it stands now is below.`,
      },
    };
  }

  const settled = await settle(page, options.settle);
  /*
   * The settled outline is not used directly.
   *
   * It is the signal that the page stopped changing, which is what the wait is
   * for. What the model reads is the capture, which is the compiled view, and
   * diffing a snapshot against a compile would report the entire page as new.
   * The two are computed from the same page at the same moment, so nothing is
   * stale in either direction.
   */
  void settled;
  await captureInto(options, page, observer);
  const changes = observer.viewChanges();
  const urlAfter = page.url();
  const navigated = urlAfter !== urlBefore;

  /*
   * "No change" is judged on the outline and the URL together, and the outline
   * is what decides. A page can push a new URL without changing what is on it
   * (a history entry, a hash, a redirect back to the same view), and reporting
   * that as a successful step would be a lie the model acts on.
   */
  const pageUnchanged = changes.text.includes("(no change)") && !navigated;

  /*
   * A program that returned a value and changed nothing is a READ, not a no-op.
   *
   * This is the distinction the first version of this got wrong, and the test
   * caught it: `page.title()` returns the title and changes nothing, so it
   * reported NO_CHANGE, which reads to the model as "your action failed". A
   * model that reads a value off a page and is told nothing happened will retry
   * it, or conclude the page is broken, when the read worked perfectly.
   *
   * So a returned value makes it a SUCCESS. That is not a technicality: the
   * program achieved what it was written to do, and the outcome has to say so or
   * the model cannot tell a successful read from a dead click.
   */
  const producedValue = result !== undefined;
  const noChange = pageUnchanged && !producedValue;

  return {
    result,
    receipt: {
      outcome: noChange ? "NO_CHANGE" : "SUCCESS",
      revision,
      after: observer.revision,
      navigated,
      urlBefore,
      urlAfter,
      changes: changes.text,
      wholesale: changes.full,
      elapsedMs: Date.now() - started,
      note: noChange
        ? `The action ran and the page did not change. Nothing was clicked that had an effect, or the change is not in the accessibility tree.`
        : pageUnchanged
          ? `The page did not change, and the program returned a value. This was a read.`
          : navigated
            ? `The page navigated from ${urlBefore} to ${urlAfter}.`
            : `The page changed without navigating.`,
    },
  };
}

/**
 * Capture the page into the observer, through the injected path when there is
 * one.
 *
 * The fallback is Playwright's snapshot, so a transaction with no capture
 * function still works: it is what a test that does not care about the
 * representation gets, and it is what happened before the compile existed. A
 * runtime always passes one.
 */
async function captureInto(
  options: { capture?: ((page: Page) => Promise<void>) | undefined },
  page: Page,
  observer: PageObserver,
): Promise<void> {
  if (options.capture) {
    await options.capture(page);
    return;
  }
  const outline = await page.ariaSnapshot({ mode: "ai" });
  observer.capture({ url: page.url(), title: await page.title().catch(() => ""), snapshot: outline });
}

/**
 * The receipt as the model reads it.
 *
 * One block, outcome first, because that is the line the model decides on. The
 * changes follow, and the note last: it is the explanation, not the answer.
 */
export function renderReceipt(receipt: StepReceipt): string {
  const lines = [
    `OUTCOME: ${receipt.outcome}`,
    `REV ${receipt.revision} -> ${receipt.after}${receipt.navigated ? ` (navigated)` : ""}`,
    `elapsed ${receipt.elapsedMs}ms`,
  ];
  if (receipt.changes.length > 0) lines.push("", receipt.changes);
  lines.push("", receipt.note);
  return lines.join("\n");
}
