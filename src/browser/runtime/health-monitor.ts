/**
 * Watching a page for the failures that look like something else.
 *
 * A page has three ways to stop working that a program cannot see from the
 * outside, and each one presents as a different bug in the model's own code.
 *
 * It can crash, and then every call throws at once with a message about a
 * closed target.
 *
 * It can stop accepting input while still rendering, answering reads and
 * navigating, which is the worst of the three because nothing errors: clicks
 * return without dispatch, typing does nothing, and the model concludes the page
 * is fine and its locator is wrong. Measured on a live mission, where the agent
 * spent thirty trace blocks proving the page's own JavaScript worked before
 * finding this by accident and then never trusting the page again.
 *
 * It can raise errors in its own code that never surface to a Playwright call,
 * which are the only explanation for a page that looks right and behaves wrong.
 *
 * This watches all three and keeps the answers, so the runtime can act on them
 * without the model having to discover them. It deliberately does not try to fix
 * anything: recovery is a decision with a cost, and this is the part that knows
 * whether it is needed.
 *
 * Kept small on purpose. A busier watchdog is a thing that can hang while the
 * browser is fine, which has been observed in the wild and is worse than no
 * watchdog, because a hang in the layer above the browser takes the browser with
 * it.
 */

import type { Page } from "playwright";

export interface PageHealth {
  /** The renderer is gone and the page cannot be used until it is replaced. */
  crashed: boolean;
  /** The page was closed, by the program or by the site. */
  closed: boolean;
  /** Errors raised in the page's own code since the last reset. */
  pageErrors: number;
  /** Failed network requests since the last reset. */
  failedRequests: number;
  /** Console errors since the last reset. */
  consoleErrors: number;
  /** The last page error message, which is often the whole explanation. */
  lastError?: string;
  /** The last URL that failed to load. */
  lastFailedUrl?: string;
}

const EMPTY: PageHealth = { crashed: false, closed: false, pageErrors: 0, failedRequests: 0, consoleErrors: 0 };

/**
 * Per-page health, accumulated from Playwright's own lifecycle events.
 *
 * One monitor per runtime rather than per page, because the pages come and go
 * and the bookkeeping has to outlive them: a page that crashed and was replaced
 * still has a health history, and the replacement has its own.
 */
export class HealthMonitor {
  private readonly health = new Map<Page, PageHealth>();
  private readonly listeners = new Set<(page: Page, health: PageHealth, reason: string) => void>();

  /**
   * Start watching one page.
   *
   * Safe to call twice for the same page: the second call sees the existing
   * record and does nothing. Pages are attached from several paths (creation,
   * restore, popup adoption) and double-counting a crash would make the health
   * numbers describe the bookkeeping rather than the page.
   */
  watch(page: Page): void {
    if (this.health.has(page)) return;
    this.health.set(page, { ...EMPTY });

    page.on("crash", () => {
      this.update(page, (state) => ({ ...state, crashed: true }));
      this.announce(page, "crash");
    });
    page.on("close", () => {
      this.update(page, (state) => ({ ...state, closed: true }));
    });
    page.on("pageerror", (error) => {
      this.update(page, (state) => ({
        ...state,
        pageErrors: state.pageErrors + 1,
        lastError: error.message.split("\n")[0] ?? error.message,
      }));
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      this.update(page, (state) => ({ ...state, consoleErrors: state.consoleErrors + 1 }));
    });
    page.on("requestfailed", (request) => {
      /*
       * The document itself failing is a health fact; a tracker not loading is
       * not. Counting every blocked image would make every page on the internet
       * look broken, and a signal that fires always is a signal nobody reads.
       */
      if (request.resourceType() !== "document") return;
      this.update(page, (state) => ({
        ...state,
        failedRequests: state.failedRequests + 1,
        lastFailedUrl: request.url().slice(0, 200),
      }));
    });
  }

  /** The health of a page. An unwatched page reads as healthy, not as unknown. */
  of(page: Page): PageHealth {
    return this.health.get(page) ?? { ...EMPTY };
  }

  /**
   * Whether a page needs the renderer replaced.
   *
   * Only a crash qualifies. A page with console errors is a page whose site has
   * bugs, which is not a reason to replace a renderer and lose the session.
   */
  needsRecovery(page: Page): boolean {
    return this.of(page).crashed;
  }

  /**
   * Clear the counters after a recovery.
   *
   * A recovered page is a new renderer, so its error counts describe the old
   * one. Keeping them would mean a page recovered once looked worse than one
   * that was never broken, and the next decision would be made against a history
   * that no longer applies.
   */
  reset(page: Page): void {
    if (!this.health.has(page)) return;
    this.health.set(page, { ...EMPTY });
  }

  /** Forget a page entirely, when it is closed for good. */
  forget(page: Page): void {
    this.health.delete(page);
  }

  /**
   * Subscribe to health transitions worth acting on.
   *
   * Only crashes are announced, because a crash is the one event that changes
   * what the runtime should do next. The rest are recorded and read on demand,
   * which keeps this from being a second event bus competing with the page
   * listeners the live pane uses.
   */
  onUnhealthy(listener: (page: Page, health: PageHealth, reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(page: Page, change: (state: PageHealth) => PageHealth): void {
    this.health.set(page, change(this.of(page)));
  }

  private announce(page: Page, reason: string): void {
    for (const listener of this.listeners) {
      try {
        listener(page, this.of(page), reason);
      } catch {
        /* A broken listener must not break the browser. */
      }
    }
  }
}

/**
 * The one-line health note the model reads.
 *
 * Returned only when something is wrong, so a healthy page adds nothing to a
 * receipt. A note that appears every step is a note that stops being read by the
 * third one.
 */
export function healthNote(page: Page, health: PageHealth): string | undefined {
  if (health.crashed) return "this page crashed and its renderer must be replaced; call recover() before using it again.";
  if (health.closed) return "this page is closed.";
  if (health.pageErrors > 0 && health.lastError !== undefined) {
    return `the page raised ${health.pageErrors} JavaScript ${health.pageErrors === 1 ? "error" : "errors"}; the last was: ${health.lastError}`;
  }
  if (health.failedRequests > 0 && health.lastFailedUrl !== undefined) {
    return `a document failed to load: ${health.lastFailedUrl}`;
  }
  return undefined;
}
