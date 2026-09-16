/**
 * One thread's browser, and the code that runs in it.
 *
 * This is the piece that makes pages and logins survive between tool calls. A
 * `Page` is a live object bound to a connection; it cannot be serialized across
 * a process boundary and proxying it would make `page.url()` return a Promise,
 * which is the one thing this design refuses to do. So the connection has to
 * live in the same process as the model's code, and that process has to outlive
 * a single call — which is why there is one long-lived worker per thread rather
 * than the fresh-per-eval worker `eval` uses.
 *
 * Two facts about Playwright shape everything here, both verified rather than
 * assumed:
 *
 * 1. **Contexts are per-connection.** `browser.contexts()` is populated by the
 *    connection that created them; a second connection sees one merged context
 *    containing every thread's pages. Contexts therefore only stay separate
 *    while the connection that made them is alive, and this runtime never drops
 *    its connection mid-thread.
 *
 * 2. **A page survives a dropped connection only if another one holds it.** So
 *    "reconnect and find my pages" is not a thing Playwright offers, and the
 *    design does not depend on it.
 *
 * Steel owns the browser process; this attaches to it over CDP. Steel is not
 * started here — the app-server does that, once, and this connects to whatever
 * is listening.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { scopeBrowser, scopePage } from "./scoped-page.js";
import {
  BrowserControlPausedError,
  BrowserControlRegistry,
  BrowserLeaseStaleError,
  type HandoffSummary,
} from "./control-lease.js";

import { perceive, type PerceptionResult } from "./engine.js";
import { countOutline, PageObserver, type PageContentMeta, type PageViewOptions, type SnapshotStats } from "./page-view.js";
import { runStep, type SettleOptions, type StepReceipt } from "./transaction.js";
import type { TransitionDb } from "./transition-db.js";

export interface ThreadRuntimeOptions {
  /** The thread this browser belongs to, for naming and logging. */
  threadId: string;
  /** CDP endpoint of the browser to attach to. */
  cdpUrl: string;
  /** How long to wait for the attach. */
  cdpTimeoutMs?: number;
  /** Contexts are created with this viewport. */
  viewport?: { width: number; height: number };
  /**
   * Where this thread's cookies are persisted, when they should be.
   *
   * Absent means in-memory only, which is right for a test and wrong for a
   * thread whose login has to survive a restart.
   */
  statePath?: string | undefined;
  /**
   * The learned site graph, when one is shared.
   *
   * Owned by the app-server rather than by a thread, because a site's shape is
   * the same for everybody and the value of the graph comes from accumulating
   * across threads.
   */
  flows?: TransitionDb | undefined;
  /**
   * The control lease registry, shared across threads.
   *
   * Shared rather than per-runtime because the registry is keyed by thread id
   * and the gateway, which handles the take-control request, has no runtime
   * object for the thread at that moment. One registry per app-server means the
   * HTTP handler and the browser tool consult the same record.
   */
  control?: BrowserControlRegistry | undefined;
}

/**
 * What a named page is.
 *
 * Names matter because `browser.page(1)` by index breaks the moment a tab
 * closes, and a model that has just opened a cart tab and gone back to the
 * listing has no way to return to it by index.
 */
export interface NamedPage {
  name: string;
  page: Page;
  openedAt: number;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

export class ThreadBrowserRuntime {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private active: Page | undefined;
  private readonly named = new Map<string, NamedPage>();
  /** The counter behind auto-generated page names. */
  private anonymousCount = 0;
  readonly observer = new PageObserver();
  /**
   * The learned site graph, when one is shared.
   *
   * Public and readonly: the tool reads it to learn an edge and to describe a
   * site, and there is exactly one per app-server rather than one per thread.
   */
  readonly flows: TransitionDb | undefined;

  /**
   * The control lease registry, when the caller shares one.
   *
   * Optional because most callers (tests, a one-off script) never hand control
   * to a human, and requiring a registry would mean constructing one to do
   * nothing. When it is present, every `step` is gated by it.
   */
  private readonly control: BrowserControlRegistry | undefined;

  constructor(private readonly options: ThreadRuntimeOptions) {
    this.flows = options.flows;
    this.control = options.control;
  }

  /** This runtime's thread id, for lease lookups. */
  get threadId(): string {
    return this.options.threadId;
  }

  /**
   * Attach if not already attached, and return the live handles.
   *
   * Concurrency-safe by construction: `connecting` holds the in-flight promise
   * so two calls arriving together attach once. Without that they would each
   * open a connection and one would be orphaned, holding a context that nothing
   * can reach and that never closes.
   */
  private connecting: Promise<void> | undefined;

  async ensureReady(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    if (this.browser && this.context && !this.browser.isConnected()) {
      // Steel restarted or the socket dropped. Drop everything: a stale context
      // is worse than a fresh one, because it looks alive and fails on use.
      this.resetHandles();
    }
    if (!this.browser || !this.context) {
      if (!this.connecting) this.connecting = this.attach().finally(() => { this.connecting = undefined; });
      await this.connecting;
    }
    const browser = this.browser;
    const context = this.context;
    if (!browser || !context) throw new Error("the browser could not be attached");
    const page = await this.resolveActivePage(context);
    return { browser, context, page };
  }

  private async attach(): Promise<void> {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(this.options.cdpUrl, {
      timeout: this.options.cdpTimeoutMs ?? 30_000,
    });
    /*
     * A new context per thread, always — never `browser.contexts()[0]`.
     *
     * The default context belongs to whoever got there first, and Steel reuses
     * one Chrome across sessions, so attaching to it shares a cookie jar with
     * every other thread. Verified as a real leak rather than inferred: a cookie
     * written in one context was readable from another when both used the
     * default.
     */
    /*
     * The thread's saved cookies are seeded into the new context, so a restart
     * does not cost every login. A missing file returns undefined and the context
     * starts clean, which is the same thing that happened before persistence
     * existed.
     */
    const state = await this.loadState();
    const context = await browser.newContext({
      viewport: this.options.viewport ?? DEFAULT_VIEWPORT,
      ...(state ? { storageState: state } : {}),
      // Steel's Chrome carries its own user agent; leaving this unset keeps it
      // consistent with what the browser reports elsewhere.
    });
    this.browser = browser;
    this.context = context;
    context.on("close", () => {
      // A script can reach `context.close()` through the sandbox. Nulling the
      // handles here is what stops the next eval finding a dead context and
      // failing every call on it.
      this.resetHandles();
    });

    /*
     * The pages this thread had open, put back.
     *
     * After the cookies are seeded, because a page that needs a session should
     * load as the signed-in user rather than as a stranger and then be
     * navigated. A failure here never fails the attach: a thread that cannot
     * rebuild one of its tabs still needs a browser.
     */
    await this.restorePages(context).catch(() => undefined);
  }

  private resetHandles(): void {
    this.browser = undefined;
    this.context = undefined;
    this.active = undefined;
    this.activeTargetId = undefined;
    this.named.clear();
  }

  /**
   * The page a script's bare `page` refers to, pinned by CDP target id.
   *
   * It used to take `pages[pages.length - 1]`, which is the "active tab"
   * pattern and is wrong the moment a second tab exists. A page that opens a
   * popup moves its own index, so the next call drives the popup; a tab that
   * closes shifts every index after it. The failures that produces are
   * intermittent and look like the site misbehaving rather than like the tool
   * picking the wrong page.
   *
   * So the page is pinned once, by the CDP target id that identifies it in the
   * browser itself, and every later call resolves that id. If the pinned target
   * is gone the answer is an error naming the target, never a silent fallback
   * to whatever tab happens to be open, because acting on the wrong page is
   * worse than not acting.
   */
  private async resolveActivePage(context: BrowserContext): Promise<Page> {
    if (this.active && !this.active.isClosed()) {
      /*
       * The handle is only reused when the target behind it is the one we
       * pinned. Playwright can hand back a Page object after its target was
       * replaced, and reusing it would drive a page the model has not seen.
       */
      if (this.activeTargetId === undefined || (await targetIdOf(this.active)) === this.activeTargetId) {
        return this.active;
      }
    }
    const pages = context.pages().filter((p) => !p.isClosed());
    const page = pages[0] ?? (await context.newPage());
    this.active = page;
    try {
      this.activeTargetId = await targetIdOf(page);
    } catch {
      this.activeTargetId = undefined;
    }
    return page;
  }

  /** The CDP target id the active page is pinned to, when it is pinned. */
  activeTargetId: string | undefined;

  /**
   * Resolve and remember the active page's CDP target id.
   *
   * Exists for the live browser pane, which needs the target id to ask Steel to
   * stream that exact page and must not receive one for a page it does not own.
   * Reading `activeTargetId` directly is not enough because it is only set once
   * a step has run, and the pane is often opened in the pause between turns when
   * the page is live but nothing has pinned it yet.
   *
   * Safe to call repeatedly: it re-reads the target behind the currently active
   * page, so a stale id is corrected rather than trusted. The id is derived
   * from the page this runtime owns, which is what keeps the pane scoped: a
   * client cannot name a target id, only a thread.
   */
  async pinActiveTarget(page?: Page): Promise<string | undefined> {
    const target = page ?? (await this.ensureReady()).page;
    this.active = target;
    this.activeTargetId = await targetIdOf(target).catch(() => undefined);
    return this.activeTargetId;
  }

  /**
   * A fresh page after the one we were driving was closed.
   *
   * Deliberately reads the context's live page list and only creates one when
   * there is genuinely nothing to use, because Steel may already have opened a
   * replacement: its own `refreshPrimaryPage` closes the old page and assigns a
   * new one, so by the time we look there is often a page waiting.
   *
   * The stale handle is dropped first. Re-using it is the failure this exists to
   * prevent: it looks like a page, it reports its old URL, and every call on it
   * rejects.
   */
  private async replaceClosedPage(): Promise<Page | undefined> {
    this.active = undefined;
    this.activeTargetId = undefined;
    const context = this.context;
    if (!context) return undefined;
    const live = context.pages().filter((candidate) => !candidate.isClosed());
    const page = live[0] ?? (await context.newPage().catch(() => undefined));
    if (!page) return undefined;
    this.active = page;
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    return page;
  }

  /** Open a page, optionally naming it. Returns the RAW handle, for the runtime. */
  async newPage(name?: string): Promise<Page> {
    const { context } = await this.ensureReady();
    const page = await context.newPage();
    const resolvedName = name ?? `page-${++this.anonymousCount}`;
    this.named.set(resolvedName, { name: resolvedName, page, openedAt: Date.now() });
    this.active = page;
    /*
     * Pin to the new page's target id immediately. Without this the first call
     * after opening a tab resolves by heuristics, and on a page that just opened
     * a popup those heuristics are exactly what picks the wrong one.
     */
    this.activeTargetId = await targetIdOf(page).catch(() => undefined);
    return page;
  }

  /**
   * Every open page, with its name when it has one.
   *
   * The map is keyed by the Playwright `Page` object itself rather than by
   * stringifying it. `String(page)` is `[object Object]` for every page, so
   * every named page collided on one key and the list reported the last name
   * for all of them — which is how a two-page session came back as
   * `['cart', 'cart']`.
   */
  pagesForDisplay(): Array<{ name: string | undefined; url: string; active: boolean; index: number }> {
    return this.pageEntries().map((entry) => ({
      name: entry.name,
      url: entry.page.url(),
      active: entry.active,
      index: entry.index,
    }));
  }

  /**
   * The thread's pages as scoped Playwright pages, each carrying its metadata.
   *
   * This is what both `browser.pages()` and a program's bare `pages()` return,
   * and they are deliberately the same call. They were not: the facade returned
   * real pages and the scope-level binding returned name/url/active records, so
   * `pages()[0].url()` worked in one place and threw "p.url is not a function"
   * in the other. A program cannot tell which of two identical-looking globals
   * it reached for, so the only safe answer is that they agree.
   *
   * The metadata is attached as non-enumerable properties rather than wrapped in
   * an object, because the page *is* the useful thing: a program wants to call
   * Playwright on it. `pageName` is what makes `browser.setActive(name)` work
   * from a page the program is holding, and `pageIndex` is what makes the
   * display order reproducible.
   *
   * Non-enumerable so the serializer does not walk them and a returned list
   * reads as a list of pages rather than a list of wrappers.
   */
  describePages(): Page[] {
    return this.pageEntries().map((entry) => {
      const page = scopePage(entry.page);
      Object.defineProperties(page, {
        pageName: { value: entry.name, enumerable: false, configurable: true },
        pageIndex: { value: entry.index, enumerable: false, configurable: true },
        isActivePage: { value: entry.active, enumerable: false, configurable: true },
      });
      return page;
    });
  }

  /**
   * The live pages with their bookkeeping, in the order `pagesForDisplay` uses.
   *
   * The one place the name map and the live list are joined, so the display
   * form and the page form cannot disagree about which index is which.
   */
  pageEntries(): Array<{ page: Page; name: string | undefined; active: boolean; index: number }> {
    if (!this.context) return [];
    const live = this.context.pages().filter((p) => !p.isClosed());
    const names = new Map<Page, string>();
    for (const entry of this.named.values()) {
      if (!entry.page.isClosed()) names.set(entry.page, entry.name);
    }
    return live.map((page, index) => ({
      page,
      name: names.get(page),
      active: page === this.active,
      index,
    }));
  }

  /**
   * This thread's pages, each with the CDP target id that names it.
   *
   * The target id is what the live view's tab list is keyed by, because it is
   * the only identifier that means the same thing to Playwright, to Steel and
   * to the browser. A `Page` object cannot cross the wire, and an index moves
   * when a tab opens or closes.
   *
   * Resolved per page rather than cached, so a tab that was replaced by the
   * site's own `window.open` is reported under its current id rather than a
   * stale one. A page whose id cannot be read is skipped rather than given a
   * placeholder: an entry the viewer cannot connect to is worse than an absent
   * one, because it looks like a tab that will not load.
   */
  async pageTargets(): Promise<Array<{ targetId: string; url: string; title: string; name: string | undefined; active: boolean }>> {
    const entries = this.pageEntries();
    const out: Array<{ targetId: string; url: string; title: string; name: string | undefined; active: boolean }> = [];
    for (const entry of entries) {
      const targetId = await targetIdOf(entry.page).catch(() => undefined);
      if (targetId === undefined) continue;
      out.push({
        targetId,
        url: entry.page.url(),
        title: await entry.page.title().catch(() => ""),
        name: entry.name,
        active: entry.active,
      });
    }
    return out;
  }

  /** Whether a CDP target id names one of this thread's pages. */
  async ownsTarget(targetId: string): Promise<boolean> {
    const targets = await this.pageTargets();
    return targets.some((entry) => entry.targetId === targetId);
  }

  /** The live Page objects, in the same order `pagesForDisplay` reports them. */
  pages(): Page[] {
    if (!this.context) return [];
    return this.context.pages().filter((p) => !p.isClosed());
  }

  /** Select the page a bare `page` will mean next. By name or by index. */
  async setActive(selector: string | number): Promise<Page> {
    const { context } = await this.ensureReady();
    if (typeof selector === "string") {
      const entry = this.named.get(selector);
      if (entry && !entry.page.isClosed()) {
        this.active = entry.page;
        this.activeTargetId = await targetIdOf(entry.page).catch(() => undefined);
        return entry.page;
      }
      throw new Error(`no open page named "${selector}". Open pages: ${[...this.named.keys()].join(", ") || "(none)"}`);
    }
    const live = context.pages().filter((p) => !p.isClosed());
    const page = live[selector];
    if (!page) throw new Error(`no page at index ${selector}; ${live.length} open`);
    this.active = page;
    return page;
  }

  /** Close a page, and forget it so a name is not left pointing at a corpse. */
  async closePage(page: Page): Promise<void> {
    for (const [name, entry] of this.named) {
      if (entry.page === page) this.named.delete(name);
    }
    if (this.active === page) this.active = undefined;
    await page.close().catch(() => undefined);
  }

  /**
   * Capture the page's outline into the observer, so the next observation is a
   * delta rather than the page.
   *
   * Called by the runtime after every action, not by the model: the model should
   * not have to remember to look. What it gets back is the diff.
   */
  async capture(page?: Page): Promise<void> {
    const target = page ?? (await this.ensureReady()).page;
    const perceived = await this.perceive(target);
    this.observer.capture({
      url: target.url(),
      title: await target.title().catch(() => ""),
      snapshot: perceived.text,
      ...(perceived.note !== undefined ? { note: perceived.note } : {}),
      stats: statsOf(perceived),
      /*
       * A fallback is delivered whole. It is not a summary of the page, it is
       * the page as Playwright describes it, and trimming it removes regions
       * with no id and no way to reach them. The budget applies to the compiled
       * view, where every section is named and can be opened by id.
       */
      untrimmed: perceived.usedFallback,
    });
  }

  /**
   * Read a page through the perception engine.
   *
   * A one-line pass-through while the engine is stubbed. It stays a method
   * rather than a direct call because the compiled engine will need per-runtime
   * state here (the previous compile, for stable section and element ids across
   * revisions) and the call sites should not have to change when it lands.
   */
  private async perceive(target: Page): Promise<PerceptionResult> {
    const perceived = await perceive(target, {
      context: {
        ...(this.observer.step !== undefined ? { step: this.observer.step } : {}),
        ...(this.observer.goal !== undefined ? { goal: this.observer.goal } : {}),
      },
    });
    this.lastWasFallback = perceived.usedFallback;
    return perceived;
  }

  /** Whether the last read produced a fallback rather than a compiled view. */
  private lastWasFallback = false;

  /**
   * What the last read cost and contains.
   *
   * Counted from the text, because that is all there is while the engine is
   * stubbed: there is no compiled element list to ask. A caller that logs a step
   * reads this to see how large an observation was, and a caller that sees
   * `fallback: true` on every read knows the compiler is not running, which is
   * the signal that would otherwise be invisible.
   */
  lastStats(): { lines: number; chars: number; elements: number; sections: number; fallback: boolean } {
    const text = this.observer.currentOutline();
    return {
      lines: text.split("\n").filter((line) => line.trim().length > 0).length,
      chars: text.length,
      elements: 0,
      sections: 0,
      fallback: this.lastWasFallback,
    };
  }

  /** The whole page, as the model should read it. */
  async view(options: PageViewOptions = {}): Promise<{
    text: string;
    truncated: boolean;
    stats: SnapshotStats;
    contentMeta: PageContentMeta;
    /** The page that was read, so a caller does not need a second round trip. */
    url: string;
  }> {
    const active = await this.ensureReady();
    /*
     * What to read, in order of specificity: a locator the caller passed, then a
     * selector, then a named page, then the active page.
     *
     * The locator case is the one that was wrong. `view(page.getByRole("main"))`
     * passes a Locator, and the first version only recognised a Page, so anything
     * else fell through to the active page and rendered the WHOLE page. The call
     * succeeded and the model got the wrong thing, which is the worst shape a bug
     * can take here: a program that scopes a look to one region to save tokens
     * silently pays for the whole page and never learns why.
     */
    const scoped = isLocator(options.page) ? options.page : undefined;
    const page = isPage(options.page) ? options.page : active.page;

    /*
     * A region read stays on Playwright's own snapshot, and a whole-page read
     * compiles.
     *
     * That split is deliberate rather than a half-finished migration. Scoping to
     * one region is what keeps a 25k-character job board down to the form the
     * model is filling, and it is something Playwright's `ariaSnapshot` does
     * well and the collector does not do at all: `collectPage` reads a whole
     * document by construction, and narrowing it to a subtree would mean
     * filtering the compile afterwards, which is a different feature. A model
     * that wants a region gets one; a model that looks at the page gets the
     * compiled view, which is the case the measurement is about.
     */
    const region = scoped ?? (options.selector ? page.locator(options.selector).first() : undefined);
    if (region !== undefined) {
      const snapshot = await region.ariaSnapshot({
        mode: "ai",
        ...(options.depth ? { depth: options.depth } : {}),
      });
      // A scoped look replaces what the observer is holding, so a later diff is
      // against what the model actually saw rather than the whole page it did not.
      this.observer.capture({ url: page.url(), title: await page.title().catch(() => ""), snapshot });
      const note = options.selector ? `selector: ${options.selector}` : undefined;
      return { ...this.observer.view(note), url: page.url() };
    }

    const perceived = await this.perceive(page);
    this.observer.capture({
      url: page.url(),
      title: await page.title().catch(() => ""),
      snapshot: perceived.text,
      ...(perceived.note !== undefined ? { note: perceived.note } : {}),
      stats: statsOf(perceived),
      /*
       * A fallback is delivered whole. It is not a summary of the page, it is
       * the page as Playwright describes it, and trimming it removes regions
       * with no id and no way to reach them. The budget applies to the compiled
       * view, where every section is named and can be opened by id.
       */
      untrimmed: perceived.usedFallback,
    });
    return { ...this.observer.view(), url: page.url() };
  }

  /**
   * The page a model program is handed, and the browser that agrees with it.
   *
   * Both scoped to this thread, because a raw page's context chain reaches every
   * other thread's contexts: `page.context().browser().contexts()` returns the
   * whole browser, and agent A driving agent B's page was confirmed with exactly
   * that line. The runtime keeps the raw handles; only model code gets these.
   */
  scopedHandles(): { page: Page; browser: Browser } {
    const page = this.active;
    const context = this.context;
    if (!page || !context) throw new Error("the browser is not attached");
    const browser = page.context().browser();
    if (!browser) throw new Error("the page has no browser");
    return { page: scopePage(page), browser: scopeBrowser(browser, context) };
  }

  /**
   * The outline the observer is holding, without acknowledging it.
   *
   * Reading the page for a verifier must not count as the model having seen it,
   * or the next `viewChanges` would report nothing and the model would miss the
   * change that just happened.
   */
  async currentOutline(): Promise<string> {
    return this.observer.currentOutline();
  }

  /** Only what differs from the last thing the model was told. */
  viewChanges(): { text: string; full: boolean } {
    return this.observer.viewChanges();
  }

  /**
   * Hand this thread's browser to the human, and remember where they started.
   *
   * The start state is captured here rather than read later because "what
   * changed during the handoff" is only answerable against a *before*, and by
   * the time control is returned the before is gone. Only non-secret facts are
   * kept: URL, title, tab count. A human takes over most often to enter
   * something the agent should not hold, and recording the page's inputs would
   * put exactly those values in the transcript.
   */
  async beginHumanControl(): Promise<{ generation: number; startedAt: number }> {
    if (!this.control) throw new Error("this runtime has no control registry");
    const { context, page } = await this.ensureReady();
    this.handoff = {
      startedAt: Date.now(),
      startedUrl: page.url(),
      startedTitle: await page.title().catch(() => ""),
      startedTabs: this.pageEntries().length,
      navigations: [],
    };
    /*
     * Watch the page while the human drives it.
     *
     * A passive listener, not an action: the CDP connection stays attached
     * through the handoff because detaching would let the browser be reaped and
     * lose the very state the handoff is about. Only the *destination* of a
     * navigation is recorded. The events this fires on carry no input, so a
     * password typed into a page that never navigates is never observed at all,
     * which is the property that matters.
     */
    const onNavigated = (frame: import("playwright").Frame): void => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      this.handoff?.navigations.push(url);
    };
    const onPage = (opened: import("playwright").Page): void => {
      this.handoff?.navigations.push(`(new tab) ${opened.url() || "about:blank"}`);
    };
    page.on("framenavigated", onNavigated);
    context.on("page", onPage);
    this.handoffListeners = () => {
      page.off("framenavigated", onNavigated);
      context.off("page", onPage);
    };
    const lease = this.control.takeControl(this.threadId);
    return { generation: lease.generation, startedAt: lease.since };
  }

  /**
   * Take control back, drop everything the agent was holding, and read the page
   * fresh.
   *
   * This is the resync, and the order matters: the cached view is discarded
   * *before* the new one is read, because the agent is about to be told the
   * state may have changed and a view that survived the handoff would let it
   * diff against a page that no longer exists. Returning the summary as well as
   * refreshing means the caller can tell the model what happened in one step
   * rather than leaving it to notice a silent difference.
   */
  async endHumanControl(): Promise<{ generation: number; summary: HandoffSummary }> {
    if (!this.control) throw new Error("this runtime has no control registry");
    const started = this.handoff;
    const { page } = await this.ensureReady();
    const endedUrl = page.url();
    const endedTitle = await page.title().catch(() => "");
    const endedTabs = this.pageEntries().length;

    /*
     * Invalidate first. `observer.reset()` drops the held outline and returns
     * the revision to zero, so the next read is a full page rather than a delta
     * against pre-handoff state, and any action still holding a pre-handoff
     * revision is refused by the ordinary stale-revision check as well as by the
     * generation check below. Two independent guards on the same race, because
     * the failure they prevent is a click landing in a page the human is typing
     * into.
     */
    this.observer.reset();
    await this.capture(page);

    const lease = this.control.returnControl(this.threadId);
    const tabDelta = endedTabs - (started?.startedTabs ?? endedTabs);
    const urlChanged = (started?.startedUrl ?? endedUrl) !== endedUrl;
    const titleChanged = (started?.startedTitle ?? endedTitle) !== endedTitle;
    /*
     * The change list is built from the facts, not from the raw event stream.
     * Consecutive navigations are collapsed because a login flow that
     * redirects twice is one event to the reader, and the destinations are
     * listed because they say *where* the human went without saying what they
     * typed to get there.
     */
    const changes: string[] = [];
    const destinations = [...new Set(started?.navigations ?? [])];
    if (destinations.length > 0) {
      changes.push(`the page navigated during the handoff, through: ${destinations.join(" -> ")}`);
    }
    if (urlChanged) changes.push(`the page ended somewhere else: ${started?.startedUrl ?? "?"} -> ${endedUrl}`);
    if (titleChanged && !urlChanged) changes.push(`the page title changed: "${started?.startedTitle ?? ""}" -> "${endedTitle}"`);
    if (tabDelta > 0) changes.push(`the user opened ${tabDelta} new tab${tabDelta === 1 ? "" : "s"}`);
    if (tabDelta < 0) changes.push(`the user closed ${-tabDelta} tab${tabDelta === -1 ? "" : "s"}`);
    if (changes.length === 0) changes.push("nothing observable changed while the user had control");

    const summary: HandoffSummary = {
      startedAt: started?.startedAt ?? lease.since,
      endedAt: Date.now(),
      startedUrl: started?.startedUrl ?? endedUrl,
      endedUrl,
      urlChanged,
      startedTitle: started?.startedTitle ?? endedTitle,
      endedTitle,
      titleChanged,
      tabDelta,
      changes,
    };
    this.handoff = undefined;
    this.handoffListeners?.();
    this.handoffListeners = undefined;
    return { generation: lease.generation, summary };
  }

  /** Where the human started, while they have control. */
  private handoff:
    | { startedAt: number; startedUrl: string; startedTitle: string; startedTabs: number; navigations: string[] }
    | undefined;
  /** Detaches the handoff listeners. Held so a return removes exactly what a take added. */
  private handoffListeners: (() => void) | undefined;

  /** Whether a human currently owns this thread's browser. */
  humanHasControl(): boolean {
    return this.control?.lease(this.threadId).owner === "human";
  }

  /**
   * The current control lease, for the pane's status line.
   *
   * Returns an agent-owned lease when this runtime has no registry, so a caller
   * that only needs to display the state does not have to handle "unknown": a
   * thread that cannot hand control is a thread the agent owns.
   */
  controlLease(): { owner: "agent" | "human"; generation: number; since: number } {
    return this.control?.lease(this.threadId) ?? { owner: "agent", generation: 0, since: 0 };
  }

  /**
   * Run one action, and come back with what changed rather than whether it threw.
   *
   * This is the loop the model should not have to write by hand: revision check,
   * act, settle, diff, receipt. A model that has to remember to re-snapshot after
   * every click will forget, and the failure is silent, because a browser that
   * did something is indistinguishable from one that did nothing until you look.
   *
   * `expectedRevision` is optional and its absence is meaningful: a first action
   * on a page has nothing to compare against, and requiring a revision would
   * make the common case awkward to express.
   */
  async step<T>(
    action: (page: Page) => Promise<T>,
    options: {
      expectedRevision?: number | undefined;
      settle?: SettleOptions | undefined;
      timeoutMs?: number | undefined;
      /**
       * The control generation this action was decided under.
       *
       * Checked here rather than at the tool boundary because this is the one
       * function every agent action passes through, and the race it closes is
       * between the decision and the doing: the model decides a click, the user
       * takes control, and the click would otherwise land on the page the human
       * is now driving. A refusal here is the earliest point the runtime can
       * tell that the world moved.
       */
      controlGeneration?: number | undefined;
    } = {},
  ): Promise<{ receipt: StepReceipt; result: T | undefined }> {
    const stepStarted = Date.now();
    /*
     * Refuse before touching the page, and before `ensureReady`, so a paused
     * thread does not even reattach. The lease lives on the runtime because the
     * runtime is per-thread and this check must use the same thread identity the
     * handoff used.
     */
    if (this.control) {
      const verdict = this.control.checkAgentAction(this.threadId, options.controlGeneration);
      if (!verdict.ok) {
        if (verdict.reason === "stale-generation") {
          throw new BrowserLeaseStaleError(options.controlGeneration ?? -1, this.control.lease(this.threadId).generation);
        }
        throw new BrowserControlPausedError(this.control.lease(this.threadId));
      }
    }
    const { page } = await this.ensureReady();
    /*
     * The baseline is captured against the page the model is *looking at*, which
     * is not necessarily the page it ends on.
     *
     * A program that opens a tab with `browser.newPage()` finishes on the new
     * page, and the first version captured the old one and then diffed the new
     * one against it. The result was a large, entirely spurious Removed/Added
     * list, because two different pages have nothing in common. The model would
     * read that as "the whole page changed" and act on it.
     *
     * So the starting page is remembered and the diff is anchored to it. When
     * the program stayed on the same page, this is the ordinary case and nothing
     * changes. When it moved, the receipt reports the tab change as the fact it
     * is, rather than pretending to be a diff of one page.
     */
    const startedOn = page;
    const startedUrl = page.url();
    await this.capture(startedOn);

    /*
     * The program is bounded, and what a bound can catch is precise.
     *
     * A program is model-written code, and a loop that never ends is a thing a
     * model writes by accident. What matters is that essentially all browser
     * code is *async*: every Playwright call awaits, and every `await` yields to
     * the event loop. So a runaway program is almost always of the form
     *
     *     while (true) { await page.locator("...").click(); }
     *
     * and a host timer catches that, verified.
     *
     * What it cannot catch is a synchronous spin, `while (true) {}`, because a
     * spinning loop never yields and the timer's callback never runs. Measured
     * rather than assumed: a host `setTimeout` does not fire during a
     * synchronous 1.5s loop on this runtime.
     *
     * That case is left unbounded, deliberately, because bounding it properly
     * means running the program on a worker thread that can be `terminate()`d,
     * and a Playwright `Page` cannot cross a thread boundary. The choice is
     * between an unbounded sync spin and no browser tool at all, and the sync
     * spin is rare enough to accept: it is a modelling mistake, not a plausible
     * one, and the turn's own supervisor still ends it. The eval tool solves the
     * same problem with a child process precisely because eval does not have to
     * hold a live object.
     */
    const timeoutMs = options.timeoutMs ?? BROWSER_STEP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(timeoutMs)), timeoutMs);
      // Do not hold the process open for a timer that is only a guard.
      timer.unref?.();
    });

    try {
      const { receipt, result } = await Promise.race([
        /*
         * The transaction captures through this runtime rather than through
         * Playwright directly, so every capture in the loop is the same
         * representation: the compile when it works, the snapshot when it does
         * not. A step that captured one way before the action and the other way
         * after would diff two different descriptions of the page and report the
         * whole thing as changed.
         */
        runStep(startedOn, this.observer, () => action(page), { ...options, capture: (target) => this.capture(target) }),
        deadline,
      ]);

      /*
       * The program may have finished on a different page than it started on.
       * Recapturing there means the next `view` is about the page the model is
       * actually on, and the receipt says the tab changed.
       */
      const endedOn = (await this.ensureReady()).page;
      if (endedOn !== startedOn && !endedOn.isClosed()) {
        await this.capture(endedOn);
        return {
          result: result as T | undefined,
          receipt: {
            ...receipt,
            note:
              `The step finished on a different tab: it started at ${startedUrl} and is now at ${endedOn.url()}. ` +
              `The lines above are that page, not a diff of the one you were on.`,
          },
        };
      }
      /*
       * Persist after the step, which is what `save()`'s own comment always
       * said happened and did not.
       *
       * The case this covers that the save-on-close cannot: a step that just
       * logged in, on a thread that then sits idle for an hour. Without this the
       * cookies exist only in the live context, and a crash, a restart or a
       * reaper pass costs the login. Best-effort and awaited, because it is a
       * small file write and a step is already hundreds of milliseconds.
       */
      await this.save().catch(() => undefined);
      return { receipt, result: result as T | undefined };
    } catch (error) {
      /*
       * A closed page is an ordinary state in Steel, not a failure.
       *
       * Steel's own model, read from `cdp.service.ts`: a session has one
       * `primaryPage`, `refreshPrimaryPage()` closes it and assigns a new one,
       * and every target-destroyed path is handled by checking
       * `page.isClosed()` and carrying on. Closing a page is something the API
       * does itself, on purpose, and it is a thing the model will do by writing
       * `page.close()` because that is what Playwright lets you write.
       *
       * So the response is to open another page and say so. The first version
       * reported BROWSER_DISCONNECTED, which tells the model the whole browser
       * is gone and sends it looking for a fault that does not exist, while the
       * fix is one word: continue on a new page.
       *
       * The target list is re-read from the connection rather than trusted from
       * the stale handle, which is what makes "a new page" actually new.
       */
      if (/Target (page|closed)|has been closed|Session closed|page has been closed/i.test((error as Error).message)) {
        const replaced = await this.replaceClosedPage().catch(() => undefined);
        return {
          result: undefined,
          receipt: {
            outcome: "SUCCESS",
            revision: this.observer.revision,
            after: this.observer.revision,
            navigated: false,
            urlBefore: "",
            urlAfter: replaced?.url() ?? "",
            changes: "",
            wholesale: false,
            elapsedMs: Date.now() - stepStarted,
            note: replaced
              ? `The page was closed, so the step could not be observed. A new page is open at ${replaced.url()} and the browser is connected: continue there.`
              : `The page was closed and could not be replaced, so the browser needs re-attaching.`,
          },
        };
      }

      if (error instanceof StepTimeoutError) {
        /*
         * A timeout still leaves a page, and the page is the useful part. The
         * model is told the program was cut off and shown where the browser
         * actually got to, rather than being told nothing at all.
         */
        await this.capture(page).catch(() => undefined);
        return {
          result: undefined,
          receipt: {
            outcome: "TIMEOUT",
            revision: this.observer.revision,
            after: this.observer.revision,
            navigated: false,
            urlBefore: page.url(),
            urlAfter: page.url(),
            changes: "",
            wholesale: false,
            elapsedMs: timeoutMs,
            note: `The program was still running after ${timeoutMs}ms and was cut off. The page is as it was left. A program that never returns is usually a loop waiting on a condition that cannot become true.`,
          },
        };
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Write cookies and localStorage now, mid-script. */
  /**
   * Write this thread's cookies and storage to disk, now.
   *
   * The first version of this called `storageState()` and threw the result away,
   * which is worse than doing nothing: a caller is told the state was saved and
   * a killed process then proves it was not.
   *
   * Atomic, because the failure this guards against is a process dying
   * mid-write, and a half-written state file is a state file that fails to parse
   * on the next read. Written when a step succeeds as well, so this is for the
   * case that cannot wait: a long program that has just logged in and still has
   * work to do.
   */
  async save(): Promise<void> {
    const context = this.context;
    if (!context || !this.options.statePath) return;
    try {
      const state = await context.storageState();
      const path = this.options.statePath;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      /*
       * Mode 0600 and a rename: cookies in the clear, protected by filesystem
       * permissions the same way Chrome protects its own, and never observable
       * half-written.
       */
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
      /*
       * The pages are saved beside the cookies, in their own file.
       *
       * Cookies alone restore a login but not the *work*: a thread that had
       * three tabs open, one of them a search result it was part-way through
       * reading, came back as a single blank page after a restart and the agent
       * had to redo the navigation that got it there. The tabs are the thread's
       * working state, and they were the one part of it nothing persisted.
       *
       * A sibling file rather than a wrapper around the storage state, because
       * `statePath` is fed straight to `newContext({ storageState })` and has to
       * stay a valid Playwright storage state. Folding the page list into it
       * would mean shaping a file a library parses to suit us.
       */
      await this.savePages(path);
    } catch {
      /*
       * Losing a login means signing in again; refusing to continue means the
       * agent cannot work. The state write is best-effort for exactly that
       * reason, and a caller that needs to know can read the file afterwards.
       */
    }
  }

  /** Where a thread's open pages are recorded, given its storage-state path. */
  private static pagesPath(statePath: string): string {
    return `${statePath}.pages.json`;
  }

  /**
   * Record the thread's pages so a restart can rebuild them.
   *
   * Names are kept because the agent addresses pages by name, and a restore
   * that gave back the right URLs under different names would be a thread whose
   * own instructions no longer resolved. The active index is kept because "the
   * page I was working on" is part of the state, not a detail.
   *
   * `about:blank` pages are skipped: they carry nothing, and restoring them
   * would fill the tab strip with blanks that mean nothing to either side.
   */
  private async savePages(statePath: string): Promise<void> {
    const entries = this.pageEntries();
    const pages = entries
      .map((entry) => ({ url: entry.page.url(), name: entry.name }))
      .filter((entry) => entry.url && entry.url !== "about:blank");
    if (pages.length === 0) return;
    const activeIndex = Math.max(0, entries.findIndex((entry) => entry.active));
    const payload = JSON.stringify({ version: 1, pages, activeIndex });
    const target = ThreadBrowserRuntime.pagesPath(statePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, target);
  }

  /**
   * Rebuild the thread's pages in a freshly attached context.
   *
   * The first saved page reuses the blank page `newContext` already made, so a
   * single-page thread restores without a stray extra tab. The rest are created
   * in order, because order is what `browser.setActive(1)` and the viewer's tab
   * strip both mean.
   *
   * Every navigation is best-effort: a site that is down, or a URL that
   * requires a login the cookies no longer cover, must not stop the thread from
   * attaching. The page is still there, at whatever the browser landed on, and
   * the agent can see that and act.
   */
  private async restorePages(context: BrowserContext): Promise<void> {
    const path = this.options.statePath;
    if (!path) return;
    let saved: { pages?: Array<{ url?: string; name?: string }>; activeIndex?: number } | undefined;
    try {
      saved = JSON.parse(await readFile(ThreadBrowserRuntime.pagesPath(path), "utf8"));
    } catch {
      return;
    }
    const pages = (saved?.pages ?? []).filter((entry) => typeof entry?.url === "string" && entry.url.length > 0);
    if (pages.length === 0) return;

    const restored: Page[] = [];
    for (const [index, entry] of pages.entries()) {
      try {
        const page = index === 0 ? (context.pages()[0] ?? (await context.newPage())) : await context.newPage();
        await page.goto(entry.url!, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
        restored.push(page);
        if (typeof entry.name === "string" && entry.name.length > 0) {
          this.named.set(entry.name, { name: entry.name, page, openedAt: Date.now() });
        }
      } catch {
        // One page that cannot be rebuilt must not cost the others.
      }
    }
    if (restored.length === 0) return;
    const activeIndex = Math.min(Math.max(saved?.activeIndex ?? 0, 0), restored.length - 1);
    this.active = restored[activeIndex];
    this.activeTargetId = await targetIdOf(restored[activeIndex]!).catch(() => undefined);
  }

  /**
   * The stored cookies and storage for this thread, for a fresh context.
   *
   * A read failure returns empty rather than throwing, for the same reason the
   * write swallows one: a missing or corrupt state file should cost a login, not
   * the run.
   */
  private async loadState(): Promise<Awaited<ReturnType<BrowserContext["storageState"]>> | undefined> {
    const path = this.options.statePath;
    if (!path) return undefined;
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as Awaited<ReturnType<BrowserContext["storageState"]>>;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    /*
     * Every handle is captured BEFORE anything is cleared.
     *
     * This read `const context = this.context; this.resetHandles(); ... if
     * (this.browser)`. Clearing first set `this.browser` to undefined, so the
     * `if` was never true and the browser connection was never closed. Every
     * runtime leaked one live socket to Steel's CDP port, and because node's
     * test runner waits for the event loop to drain, a suite that passed every
     * assertion hung forever and CI reported a timeout with no failing test to
     * look at.
     */
    const context = this.context;
    const browser = this.browser;
    /*
     * Persist before anything is torn down, and this is the fix for a real bug
     * rather than a tidy-up.
     *
     * `save()` existed and was only reachable if the *model* called it. Nothing
     * called it on the way out, so the state file was never written at all:
     * every thread started from a clean context, and every login, cookie and
     * local-storage value was gone the moment the idle reaper closed the
     * browser. Reproduced: set a cookie, close the runtime the way the reaper
     * does, reattach, and the cookie is absent and no state file exists.
     *
     * Here rather than in `close()`'s caller because this is the one place that
     * has both the live context and the knowledge that it is about to be
     * destroyed. `resetHandles` below clears `this.context`, so this must run
     * first.
     */
    if (context) await this.save().catch(() => undefined);

    this.resetHandles();

    /*
     * The context first: closing it releases this thread's cookies and pages,
     * and doing it before the connection goes means a half-finished close still
     * leaves the browser in a known state.
     */
    if (context) await context.close().catch(() => undefined);

    /*
     * `browser.close()` on a CDP connection detaches *this* connection. It does
     * not stop Steel's Chrome: Steel owns the process, and the browser
     * outliving a thread is what makes a login survive one. Detaching is what
     * this must do, and it must actually happen, which is the bug above.
     */
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * The stats a perception produced, in the shape the observer reports.
 *
 * The compiled view has no `[ref=]` markers for `countOutline` to find, so the
 * compiler's own counts are passed instead. `interactive` is the one field that
 * cannot be answered from the compile directly: an element carrying a locator is
 * one the model can act on, which is what the field means.
 */
function statsOf(perceived: PerceptionResult): SnapshotStats {
  /*
   * Counted from the text, because that is what the stub produces and the text
   * is Playwright's own snapshot: it marks every addressable element with
   * `[ref=...]`, so the counts are real, and `countOutline` finds them the same
   * way it always did.
   *
   * This was reading `perceived.ir.elements.size` while the compiler existed,
   * because a compiled view has no ref markers to count. When the compiler
   * returns it will need the branch back; until then the text is the only source
   * and it is an accurate one.
   */
  const text = perceived.text;
  const counted = countOutline(text, false);
  return {
    lines: text.split("\n").filter((line) => line.trim().length > 0).length,
    chars: text.length,
    refs: counted.refs,
    interactive: counted.interactive,
  };
}

/**
 * A page's CDP target id.
 *
 * The browser's own identifier for the tab, which is the only handle that keeps
 * meaning the same thing when tabs open and close. Playwright's `Page` object is
 * a handle to it, not an identity: two Page objects can refer to the same
 * target, and a Page can outlive the target it was created for.
 *
 * Taken through a temporary session rather than a long-lived one, so a pinning
 * check does not itself become a resource that has to be torn down.
 */
async function targetIdOf(page: Page): Promise<string | undefined> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
    return info.targetInfo?.targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * True when a value is a Playwright Page rather than something else.
 *
 * Structural because Playwright's classes are internal-prefixed and an
 * `instanceof` against a type imported across a version boundary is fragile. The
 * two fields checked are the ones a page has and a locator does not: `goto` and
 * `url`.
 */
function isPage(value: unknown): value is Page {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["goto"] === "function" && typeof candidate["url"] === "function";
}

/**
 * True when a value is a Playwright Locator.
 *
 * Distinguished from a Page by `ariaSnapshot` plus the absence of `goto`: a
 * locator can snapshot itself and cannot navigate. Checked in that order because
 * a Page also has `ariaSnapshot`, so the page test has to run first.
 */
function isLocator(value: unknown): value is import("playwright").Locator {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ariaSnapshot"] === "function" && typeof candidate["goto"] !== "function";
}

/** How long a single browser program may run before it is cut off. */
export const BROWSER_STEP_TIMEOUT_MS = 120_000;

/**
 * Raised when a program exceeded its deadline.
 *
 * A named class rather than a string check, because the catch has to tell a
 * timeout from a program that threw: one means "you wrote a loop that never
 * ends", the other means "your program hit an error", and they call for
 * different fixes from the model.
 */
export class StepTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the program was still running after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}
