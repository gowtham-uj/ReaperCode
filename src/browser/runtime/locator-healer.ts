/**
 * One repair path for a locator that stopped matching.
 *
 * A model writes a locator, it fails, and what happens next is a decision. There
 * are three options and the runtime should take the first two before involving
 * the model at all:
 *
 *   1. the cached locator that worked for this target before
 *   2. a deterministic repair derived from the page itself
 *   3. the model, with local context rather than the whole page
 *
 * The measured waste this removes is the middle of that list being absent. A
 * site re-rendered and a selector that had worked twenty times stopped working,
 * and the model re-derived it from scratch by looking at the page. A cache turns
 * that into a lookup and a trial.
 *
 * The cache is keyed by what the model meant rather than by what it wrote, which
 * is the whole difficulty: `getByRole("button", { name: "Register" })` and
 * `#register-btn` are the same intent, and a cache keyed on the selector string
 * would not survive the site changing its markup. So the key is the accessible
 * name plus the role plus the page, which is stable across a re-render in the
 * way a CSS path is not.
 *
 * Nothing here replays blindly. A cached locator is tested with a trial before
 * it is used, so a stale entry costs one cheap check rather than a wrong click.
 * That is the difference between a cache and a hazard.
 */

import type { Locator, Page } from "playwright";

import { inspectLocator } from "./inspect.js";

interface CacheEntry {
  /** What the model was trying to reach: role, name, or text. */
  intent: string;
  /** The locator expression that worked, in the form that can be rebuilt. */
  selector: string;
  /** The URL it worked on, so a cache hit on another site is not a hit. */
  url: string;
  hits: number;
  at: number;
}

/**
 * Repairs locators, and remembers the ones that worked.
 *
 * Per-runtime rather than global, because it is scoped to one thread's session:
 * a locator that works on one site says nothing about another, and a shared
 * cache would leak one mission's shape into the next one's.
 */
export class LocatorHealer {
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly MAX_ENTRIES = 300;

  /**
   * Remember a locator that worked.
   *
   * Called after a successful action rather than before, because what is worth
   * caching is a locator that has actually resolved and been acted on. A locator
   * that merely resolves can still be the wrong element, and caching that is how
   * a healer learns to click the wrong thing reliably.
   */
  remember(intent: string, selector: string, url: string): void {
    const key = this.key(intent, url);
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      existing.selector = selector;
      existing.hits += 1;
      existing.at = Date.now();
      return;
    }
    this.cache.set(key, { intent, selector, url, hits: 1, at: Date.now() });
    if (this.cache.size > LocatorHealer.MAX_ENTRIES) {
      /*
       * Evict the least used, not the oldest. A locator that has worked thirty
       * times on a site the mission is still on is the one worth keeping, and it
       * may well be the oldest entry in the table.
       */
      let worst: [string, CacheEntry] | undefined;
      for (const entry of this.cache) {
        if (worst === undefined || entry[1].hits < worst[1].hits) worst = entry;
      }
      if (worst !== undefined) this.cache.delete(worst[0]);
    }
  }

  /**
   * A cached locator for this intent, validated against the current page.
   *
   * The validation is the point. A cache that returns a locator without checking
   * it is a cache that will eventually click something else, and the failure
   * mode of a wrong click is much worse than the cost of a failed one. So the
   * candidate is trialled, and a candidate that no longer matches is evicted
   * rather than returned.
   */
  async recall(intent: string, url: string, page: Page): Promise<Locator | undefined> {
    const entry = this.cache.get(this.key(intent, url));
    if (entry === undefined) return undefined;
    const locator = page.locator(entry.selector).first();
    const inspection = await inspectLocator(page, locator).catch(() => undefined);
    if (inspection === undefined || !inspection.actionable) {
      this.cache.delete(this.key(intent, url));
      return undefined;
    }
    entry.hits += 1;
    entry.at = Date.now();
    return locator;
  }

  /**
   * The intent behind a locator, as a cache key.
   *
   * A locator object does not expose its expression, so the intent is derived
   * from what the caller knows: the role and name it asked for, or the text it
   * looked for. When a caller cannot state an intent there is nothing to key on,
   * and the answer is to skip the cache rather than to key on a guess.
   */
  key(intent: string, url: string): string {
    return `${siteOf(url)}::${intent.trim().toLowerCase().slice(0, 200)}`;
  }

  /** How many locators are cached. For diagnostics and tests. */
  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * The site a URL belongs to.
 *
 * The host alone, because a cache entry is about a site's markup and a path is
 * exactly the part that changes between pages. Keying on the full URL would mean
 * a locator learned on `/login` is not offered on `/register`, when the header
 * markup is identical.
 */
function siteOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * The local context a model needs to rewrite a broken locator.
 *
 * Deliberately not the page. The model already looked at the page and derived
 * the locator that broke, so handing it the page again is handing it the same
 * information that produced the wrong answer. What it needs is the neighbourhood
 * of where the element should be: what is around it, what its siblings are
 * called, and which of the candidates has a real box.
 *
 * ## What it searches for
 *
 * The hint is whatever the failure managed to name, which is usually a role and
 * a name (`getByRole("button", { name: "Delete" })`) or a CSS path. Both are
 * reduced to the words in them, because the point is to find candidates rather
 * than to re-run the same query: a search for the exact broken selector would
 * find exactly what the broken selector found, which is the failure.
 */
export async function localContext(page: Page, hint: { text?: string; role?: string; name?: string }): Promise<string> {
  const raw = await page
    .evaluate((search: { text?: string; role?: string; name?: string }) => {
      /*
       * The words, not the selector. `getByRole("button", { name: "Delete" })`
       * becomes ["button", "delete"], and both are matched against an element's
       * role and its text. A word that is a CSS operator or a tag name is kept,
       * because "button" is a useful filter and ">" is not.
       */
      const source = `${search.text ?? ""} ${search.name ?? ""} ${search.role ?? ""}`;
      const words = source
        .split(/[^A-Za-z0-9_-]+/)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length >= 3 && !["getby", "role", "button", "locator", "first", "nth", "hastext"].includes(word));
      if (words.length === 0) return [];
      const out: Array<{ tag: string; role: string; name: string; box: string; text: string }> = [];
      const nodes = Array.from(document.querySelectorAll("button, a, input, select, textarea, [role], li, span, td, svg"));
      for (const node of nodes) {
        const label = (
          node.getAttribute("aria-label") ??
          (node as HTMLElement).innerText ??
          node.textContent ??
          ""
        )
          .trim()
          .toLowerCase();
        const matches = words.some((word) => label.includes(word));
        if (!matches) continue;
        const rect = node.getBoundingClientRect();
        out.push({
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute("role") ?? "",
          name: (node.getAttribute("aria-label") ?? "").slice(0, 80),
          box: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          text: (node.textContent ?? "").trim().slice(0, 80),
        });
        if (out.length >= 8) break;
      }
      return out;
    }, hint)
    .catch(() => [] as Array<{ tag: string; role: string; name: string; box: string; text: string }>);

  if (raw.length === 0) return "LOCAL CONTEXT: nothing on the page matches that description.";
  /*
   * A zero-area candidate is called out, because it is the reason a locator that
   * "matches" still cannot be clicked and it is the one thing a model reading a
   * list of elements cannot tell from the text.
   */
  const lines = raw.map((entry) => {
    const dead = entry.box === "0x0" || entry.box.startsWith("0x") || entry.box.endsWith("x0");
    return `  <${entry.tag}${entry.role ? ` role=${entry.role}` : ""}> box ${entry.box}${dead ? " (ZERO AREA, not clickable)" : ""} "${entry.text}"`;
  });
  return `LOCAL CONTEXT: ${raw.length} candidates near where you were looking\n${lines.join("\n")}`;
}
