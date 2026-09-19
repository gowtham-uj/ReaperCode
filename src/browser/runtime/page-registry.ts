/**
 * Every page this thread has, with a stable name and a record of where it came
 * from.
 *
 * The waste this removes was the single largest source of pointless work in the
 * measured mission: fifty-two calls that existed only to find a page the model
 * had already found. The shape was always the same, and it is the shape the
 * Playwright docs demonstrate:
 *
 *     const tabs = await browser.pages();
 *     for (const tab of tabs) {
 *       if ((await tab.url()).includes("parabank")) { ... }
 *     }
 *
 * Every one of those is a round trip per tab to re-derive something the runtime
 * has known since the tab opened. The model was not being careless; it had no
 * other way to ask. `browser.pages()` returned objects with a URL and nothing
 * else, so a model that wanted "the parabank tab" had to go and match on it, and
 * it had to do that again on the next step because nothing carried the answer
 * forward.
 *
 * So a page is registered once, given an id and a name, and can be addressed by
 * either afterwards:
 *
 *     const page = await browser.page("parabank");
 *     const page = await browser.page("p5");
 *
 * ## Provenance
 *
 * The second job is recording how a page came to exist, and it is not
 * bookkeeping for its own sake. A benchmark that asks for a popup is asking
 * whether a click on the page caused one; a program that calls
 * `context.newPage()` has produced a tab and not a popup, and a task that
 * accepts the second for the first has been passed without being done. That
 * distinction cannot be recovered after the fact, so it is recorded when the
 * page appears, from the event that produced it.
 */

import type { Page } from "playwright";

/** How a page came to exist. */
export type CreationType = "popup" | "newPage" | "restored" | "recovery";

export interface RegistryEntry {
  /** `p1`, `p2`, in order of appearance. Stable for the thread's lifetime. */
  id: string;
  /** The name the model gave it, or one generated from the thread id. */
  name: string;
  page: Page;
  openedAt: number;
  creationType: CreationType;
  /** The page that caused this one, when a click produced a popup. */
  parentId?: string;
  /**
   * The action whose click produced this page.
   *
   * Set only when a popup was raised while an action was running, which is what
   * makes it evidence rather than a guess: a page that appears during action
   * a91 and was raised by that action's click is attributable, and one that
   * appears between actions is not.
   */
  openedBy?: string;
}

/** What the registry knows about one page, for listing. */
export interface PageSummary {
  id: string;
  name: string;
  url: string;
  title: string;
  active: boolean;
  creationType: CreationType;
  openedBy?: string;
}

export class PageRegistry {
  private readonly byName = new Map<string, RegistryEntry>();
  private readonly byId = new Map<string, RegistryEntry>();
  private counter = 0;

  /**
   * The action currently running, so a page that appears during it is
   * attributable to it.
   *
   * Set by the runtime around each step rather than passed in, because the page
   * is created by Playwright's own event, which nothing in the program's call
   * stack receives. This is the only way to tie an event to the action that
   * caused it, and without it provenance would be a property of timing rather
   * than of causation.
   */
  private currentAction: string | undefined;

  setCurrentAction(actionId: string | undefined): void {
    this.currentAction = actionId;
  }

  /**
   * Register a page, keeping any id it already has.
   *
   * Idempotent by target: registering the same page twice returns the existing
   * entry rather than minting a second id for it. That matters because a page is
   * registered from three places (the runtime opening one, the restore path, the
   * popup listener) and two ids for one tab would make `browser.page("p3")`
   * depend on which path ran last.
   */
  register(
    name: string,
    page: Page,
    options: { creationType?: CreationType; parent?: Page; openedBy?: string } = {},
  ): RegistryEntry {
    for (const entry of this.byName.values()) {
      if (entry.page === page) {
        /*
         * A page can be renamed, and the id survives because the id is the
         * stable handle and the name is the human one. Rebinding rather than
         * replacing keeps a program that held `p3` working after the model
         * named the tab.
         */
        if (entry.name !== name) {
          this.byName.delete(entry.name);
          entry.name = name;
          this.byName.set(name, entry);
        }
        if (options.creationType !== undefined) entry.creationType = options.creationType;
        if (options.parent !== undefined) {
          const parentId = this.idOf(options.parent);
          if (parentId !== undefined) entry.parentId = parentId;
        }
        if (options.openedBy !== undefined) entry.openedBy = options.openedBy;
        return entry;
      }
    }
    /*
     * A name that comes back gets its old id back.
     *
     * This is the reconnect case, and it was a real failure before it was a rule.
     * A reconnect replaces every `Page` object: the runtime re-attaches, the old
     * handles are dead, and the thread's tabs are restored as new objects under
     * the same names. Minting fresh ids for them meant the model's `p8` silently
     * stopped resolving, and a measured run hit exactly that:
     *
     *   no open page named "p8". Open pages: p15 "github", p20 "playwright-docs"
     *
     * The model had done nothing wrong. It was holding the handle the runtime had
     * given it, and the runtime had moved the handle over the reconnect, which is
     * precisely what a handle must not do. The id counter keeps climbing, so the
     * old id is not reused by a *different* page; what happens here is that the
     * entry for that name is transferred to the new object.
     *
     * Matched by name rather than by URL, because the name is the identity the
     * model chose and a restore can land on a different URL (a form that
     * redirected, a page that remembered where it was).
     */
    const stale = this.byName.get(name);
    if (stale !== undefined) {
      this.byId.delete(stale.id);
      stale.page = page;
      stale.openedAt = Date.now();
      if (options.creationType !== undefined) stale.creationType = options.creationType;
      this.byId.set(stale.id, stale);
      return stale;
    }

    this.counter += 1;
    const parentId = options.parent !== undefined ? this.idOf(options.parent) : undefined;
    /*
     * The action is attached whenever one is running and the caller did not say
     * otherwise.
     *
     * A popup raised by a click is registered while that click's action is
     * current, and that is precisely the fact a provenance check needs: it is
     * what separates a page a click caused from a page the program asked for.
     */
    const openedBy = options.openedBy ?? this.currentAction;
    const entry: RegistryEntry = {
      id: `p${this.counter}`,
      name,
      page,
      openedAt: Date.now(),
      creationType: options.creationType ?? (openedBy !== undefined ? "popup" : "newPage"),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(openedBy !== undefined ? { openedBy } : {}),
    };
    this.byName.set(name, entry);
    this.byId.set(entry.id, entry);
    return entry;
  }

  /** The entry for a page, by object identity. */
  entryOf(page: Page): RegistryEntry | undefined {
    for (const entry of this.byName.values()) if (entry.page === page) return entry;
    return undefined;
  }

  /** The id of a page, when it is registered. */
  idOf(page: Page): string | undefined {
    return this.entryOf(page)?.id;
  }

  /**
   * Find a page by name, by id, by index into the display order, or by object.
   *
   * One lookup for all four because a model reaches for all four and each is a
   * legitimate way to mean a particular tab. `find` returning undefined rather
   * than throwing lets the caller decide the message, which is what makes the
   * error in `setActive` able to list what is actually open.
   */
  find(selector: string | number | Page): RegistryEntry | undefined {
    if (typeof selector === "number") {
      const live = this.live();
      return live[selector];
    }
    if (typeof selector === "string") {
      const byName = this.byName.get(selector);
      if (byName !== undefined && !byName.page.isClosed()) return byName;
      const byId = this.byId.get(selector);
      if (byId !== undefined && !byId.page.isClosed()) return byId;
      return undefined;
    }
    return this.entryOf(selector);
  }

  /** Every entry whose page is still open, in registration order. */
  live(): RegistryEntry[] {
    return [...this.byName.values()].filter((entry) => !entry.page.isClosed());
  }

  /** Every entry, open or not, for the restore path and for tests. */
  entries(): RegistryEntry[] {
    return [...this.byName.values()];
  }

  /** Remove a closed page, so a name is not left pointing at a corpse. */
  forget(page: Page): void {
    const entry = this.entryOf(page);
    if (entry === undefined) return;
    this.byName.delete(entry.name);
    this.byId.delete(entry.id);
  }

  /** Forget everything, for a reconnect that re-adopts the thread's pages. */
  clear(): void {
    this.byName.clear();
    this.byId.clear();
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every registered name, for an error message that lists what is open. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /** `values()` in registration order, so existing iteration keeps working. */
  values(): IterableIterator<RegistryEntry> {
    return this.byName.values();
  }

  /**
   * The pages as the model reads them.
   *
   * The id is first because it is the stable handle, and the name is second
   * because it is what a person would use. Both are printed on every list, which
   * is what stops the model from going back to `browser.pages()` to work out
   * which tab it wants.
   */
  async render(active: Page | undefined): Promise<string> {
    const live = this.live();
    /*
     * `TABS:` rather than `PAGES:`, and the distinction is not cosmetic.
     *
     * `PAGES:` is already the prefix the runtime uses for the note that explains
     * a page appearing or disappearing ("This thread had no pages left, so a
     * blank page was opened"). Two different things under one prefix is how a
     * model learns to skip a heading rather than read it, and the checked-in
     * output of a real run shows exactly the collision.
     *
     * `TABS` is also the word a model reaches for when it means this: the
     * thinking traces of all three runs say "tab" and never "page" when they are
     * talking about the list.
     */
    if (live.length === 0) return "TABS: (none open)";
    const lines: string[] = [];
    for (const entry of live) {
      const url = entry.page.url();
      const marker = entry.page === active ? "*" : " ";
      const origin = entry.openedBy !== undefined ? `  opened by ${entry.openedBy}` : "";
      lines.push(`${marker} ${entry.id} "${entry.name}" ${url}${origin}`);
    }
    /*
     * The id first, the name second, and the active one starred.
     *
     * The id is the stable handle and the name is the human label, and both are
     * printed because a model that has seen `p5` in a listing should be able to
     * come back to it, while a model reading its own plan will more often say
     * "parabank".
     */
    return `TABS:\n${lines.join("\n")}`;
  }
}
