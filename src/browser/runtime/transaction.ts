/**
 * `browser.tx`: a unit of browser work that reports what it changed.
 *
 * The problem with a bare program is what comes back. Today a program returns
 * its own value and Reaper appends the page, or a diff, or nothing, and the
 * model is left to work out whether the action landed. That is a decision the
 * runtime can make, and making it costs the model a reasoning pass per step over
 * a hundred steps.
 *
 * A transaction is the same program with the observation built in:
 *
 *     return await browser.tx({ page: "parabank", name: "submit registration" }, async ({ page }) => {
 *       await page.getByRole("button", { name: "Register" }).click();
 *       return { heading: await page.locator("h1").textContent() };
 *     });
 *
 * and what comes back is a receipt rather than a page:
 *
 *     {
 *       status: "success",
 *       action: "submit registration",
 *       page: { id: "p5", urlBefore: "...", urlAfter: "..." },
 *       change: { changed: true, navigated: false, popupOpened: false, pageClosed: false },
 *       result: { heading: "Welcome" },
 *       timing: { totalMs: 842 }
 *     }
 *
 * A few hundred tokens, and it says the four things the model actually needs:
 * did it work, what changed, what did the program return, and how long did it
 * take. The full page tree is not appended, which is the point: the tree is
 * fetched when the model asks to see it, and it is not fetched because a click
 * happened.
 *
 * This is Agent-E's change observation, and it is also the thing the Playwright
 * CLI does for its own agents: report what the command did rather than dumping
 * the page it did it on.
 */

import type { Page } from "playwright";

import type { BrowserFailure } from "./failure.js";

export type TransactionStatus = "success" | "failed" | "recovered" | "blocked";

export interface TransactionPageRef {
  id: string;
  name?: string;
  alias?: string;
  urlBefore: string;
  urlAfter: string;
  title?: string;
}

/** What changed on the page during the transaction. */
export interface TransactionChange {
  /** Anything at all changed: DOM, URL, tabs, downloads, dialogs. */
  changed: boolean;
  navigated: boolean;
  urlChanged: boolean;
  popupOpened: boolean;
  pageClosed: boolean;
  /** Number of console errors raised during the transaction. */
  consoleErrors: number;
  /** Number of failed requests during the transaction. */
  failedRequests: number;
}

export interface TransactionTiming {
  /** The whole transaction, including settling. */
  totalMs: number;
  /** Time spent waiting for the page to stop changing. */
  waitingMs: number;
}

/**
 * What a transaction reports.
 *
 * Generic over the program's return value so a caller can read it typed, and
 * serialised as plain data so it crosses the sandbox boundary without a special
 * case.
 */
export interface BrowserReceipt<T = unknown> {
  /** Stable id, so a receipt can be referred to in the ledger and by the model. */
  actionId: string;
  status: TransactionStatus;
  /** The name the model gave the step, when it gave one. */
  action?: string;
  page: TransactionPageRef;
  change: TransactionChange;
  result?: T;
  failure?: BrowserFailure;
  timing: TransactionTiming;
  /**
   * Something the model should read before its next step.
   *
   * Health notes, sleep warnings, tab-switch notices. Kept out of `change`
   * because it is advice rather than a fact about the page.
   */
  notes?: string[];
}

/**
 * The receipt as the model reads it.
 *
 * Compact by construction. The status leads because that is the line the model
 * decides on, then what changed, then the value the program returned. The
 * whole-page tree is never here: a model that wants it asks for it, and the
 * reason it asks is that this receipt told it something it did not understand.
 */
export function renderTransaction(receipt: BrowserReceipt): string {
  const lines = [`TX ${receipt.actionId} ${receipt.status.toUpperCase()}${receipt.action !== undefined ? ` "${receipt.action}"` : ""}`];
  const page = receipt.page;
  const moved = page.urlBefore !== page.urlAfter;
  lines.push(
    `  page ${page.id}${page.name !== undefined ? ` "${page.name}"` : ""}: ${moved ? `${page.urlBefore} -> ${page.urlAfter}` : page.urlAfter}`,
  );
  const changed = receipt.change;
  const flags = [
    changed.navigated ? "navigated" : undefined,
    changed.popupOpened ? "popup opened" : undefined,
    changed.pageClosed ? "page closed" : undefined,
    changed.consoleErrors > 0 ? `${changed.consoleErrors} console errors` : undefined,
    changed.failedRequests > 0 ? `${changed.failedRequests} failed requests` : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  lines.push(`  ${changed.changed ? `changed${flags.length > 0 ? `: ${flags.join(", ")}` : ""}` : "NO CHANGE"}`);
  lines.push(`  ${receipt.timing.totalMs}ms (${receipt.timing.waitingMs}ms waiting)`);
  if (receipt.failure !== undefined) {
    lines.push(`  ${receipt.failure.kind}: ${receipt.failure.diagnostic}`);
    if (receipt.failure.recommendedNext !== undefined) lines.push(`  next: ${receipt.failure.recommendedNext}`);
  }
  if (receipt.result !== undefined) {
    /*
     * The program's value, rendered as JSON when it is data and as text when it
     * is not. A model that returned an object wants to read its fields; one that
     * returned a string does not want it quoted.
     */
    const rendered = typeof receipt.result === "string" ? receipt.result : safeJson(receipt.result);
    lines.push(`  result: ${rendered}`);
  }
  for (const note of receipt.notes ?? []) lines.push(`  NOTE: ${note}`);
  return lines.join("\n");
}

/** JSON that never throws on a cycle, because a program can return anything. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Build a receipt from the page, before and after.
 *
 * Deliberately takes plain values rather than pages, so it can be built at the
 * point where the page is still alive and the receipt can outlive it. A program
 * that closes the page it was driving still produced a transaction, and a
 * receipt that needed a live page to render would have nothing to say about it.
 */
export function buildReceipt<T>(input: {
  actionId: string;
  status: TransactionStatus;
  action?: string | undefined;
  pageId: string;
  pageName?: string | undefined;
  pageAlias?: string | undefined;
  urlBefore: string;
  urlAfter: string;
  title?: string | undefined;
  changed: TransactionChange;
  result?: T | undefined;
  failure?: BrowserFailure | undefined;
  totalMs: number;
  waitingMs: number;
  notes?: string[] | undefined;
}): BrowserReceipt<T> {
  return {
    actionId: input.actionId,
    status: input.status,
    ...(input.action !== undefined ? { action: input.action } : {}),
    page: {
      id: input.pageId,
      ...(input.pageName !== undefined ? { name: input.pageName } : {}),
      ...(input.pageAlias !== undefined ? { alias: input.pageAlias } : {}),
      urlBefore: input.urlBefore,
      urlAfter: input.urlAfter,
      ...(input.title !== undefined ? { title: input.title } : {}),
    },
    change: input.changed,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.failure !== undefined ? { failure: input.failure } : {}),
    timing: { totalMs: input.totalMs, waitingMs: input.waitingMs },
    ...(input.notes !== undefined && input.notes.length > 0 ? { notes: input.notes } : {}),
  };
}

/**
 * Compare two snapshots of the thread's pages into a `TransactionChange`.
 *
 * The tab-level facts are compared across every page rather than read from the
 * captured one, and that is the fix for the failure that cost a mission twenty
 * calls: a program drove a tab it had selected by URL while the receipt was
 * rendered from the active page, so the receipt said nothing happened and the
 * agent spent twenty calls investigating a click that had worked.
 */
export function diffPages(
  before: Map<string, string>,
  after: Map<string, string>,
  options: { urlBefore: string; urlAfter: string; observedChange: boolean; consoleErrors?: number; failedRequests?: number } = {
    urlBefore: "",
    urlAfter: "",
    observedChange: false,
  },
): TransactionChange {
  let popupOpened = false;
  let pageClosed = false;
  for (const id of after.keys()) if (!before.has(id)) popupOpened = true;
  for (const id of before.keys()) if (!after.has(id)) pageClosed = true;

  let anyUrlMoved = false;
  for (const [id, url] of after) {
    const previous = before.get(id);
    if (previous !== undefined && previous !== url) anyUrlMoved = true;
  }

  return {
    /*
     * Changed is true when anything at all moved, including a tab the receipt
     * is not about. That is the whole point of comparing every page: work done
     * elsewhere is still work, and reporting it as no-change is the bug.
     */
    changed: options.observedChange || popupOpened || pageClosed || anyUrlMoved,
    navigated: options.urlBefore !== options.urlAfter,
    urlChanged: anyUrlMoved || options.urlBefore !== options.urlAfter,
    popupOpened,
    pageClosed,
    consoleErrors: options.consoleErrors ?? 0,
    failedRequests: options.failedRequests ?? 0,
  };
}

/** True when a page handle is still usable, without throwing on a closed one. */
export function isUsable(page: Page | undefined): page is Page {
  if (page === undefined) return false;
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}
