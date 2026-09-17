/**
 * What a model's browser program is handed, and where the calls come from.
 *
 * The program runs inside the sandbox with no browser connection. It holds
 * proxies, and every Playwright call travels back over the IPC socket to be
 * replayed here against the thread's own page. This module is the host end of
 * that: it owns the roots, answers the frames, and runs the observation helpers
 * that are not Playwright calls.
 *
 * ## Why the surface is four things and not one
 *
 * The question "is `page` enough" has a clear answer, and it is no. A model that
 * can only act on the page it was given cannot open a tab, cannot close one, and
 * cannot find its way back to a tab it left. So the surface is:
 *
 *   page          the scoped Playwright Page: click, fill, goto, locator, close
 *   browser       page lifecycle: newPage(name), pages(), usePage(name|index)
 *   view          what the page looks like, for the model to read
 *   viewChanges   what changed since it last looked
 *
 * `page` and `browser` are Playwright-shaped, so a model writing Playwright
 * writes what it already knows. The difference is that `browser` is a facade
 * over the runtime rather than a raw Playwright Browser, because page *naming*
 * is the runtime's job: a page opened through raw Playwright is anonymous and
 * unpinned, and a model that opens a tab and returns to the listing has no way
 * to name the one it left. Rooting `browser` here is what keeps `pages()` and
 * `usePage("cart")` working, and it costs nothing because the proxy replays
 * against whatever object the host chose.
 *
 * `page` is the real Playwright Page, scoped. Everything on it works, including
 * `page.close()`, because the proxy replays any method: nothing here enumerates
 * the Page API, so nothing here goes stale when Playwright adds to it.
 *
 * ## Isolation
 *
 * The scoping is what keeps one agent out of another's tabs, and it is applied
 * to the object the handle roots at, so it holds for every call the model makes
 * through it. A model writing `page.context().browser().contexts()` gets this
 * thread's context and nothing else, because `scopePage` and `scopeBrowser`
 * already dead-end that chain. This module does not re-implement any of it.
 */

import type { Page } from "playwright";

import { RemotePageHost, type CallResult } from "./remote-page.js";
import { scopePage } from "./scoped-page.js";
import type { ThreadBrowserRuntime } from "./thread-runtime.js";

/** The observation helpers, which are not Playwright calls. */
export interface ObserveSurface {
  view: (target?: Page) => Promise<string>;
  viewChanges: () => string;
  screenshot: (target?: Page) => Promise<string>;
}

/**
 * The page-lifecycle facade a program's `browser` is rooted at.
 *
 * Deliberately not a Playwright Browser. It offers the four things a browsing
 * task needs and nothing else, because every method here has to keep the
 * runtime's own bookkeeping true: a page opened through this is named, pinned
 * active, and listed, which is what makes `pages()` and `usePage` mean something
 * a few steps later.
 */
export class BrowserFacade {
  constructor(private readonly runtime: ThreadBrowserRuntime) {
    this.initial = runtime.activePage;
  }

  /** The page that was active when this facade was made, as a fallback. */
  private readonly initial: Page | undefined;

  /*
   * Every page this hands out is SCOPED, and that is not a detail.
   *
   * These returned the runtime's raw pages, so a program that opened a tab
   * through the facade and then walked the chain from that tab reached every
   * other thread: `tab.context().browser().contexts()` returned 2 contexts and
   * listed another agent's page by URL. Verified by running it. The scoping was
   * applied only to the primary root, which closed the chain for a program that
   * started from `page` and left it open for one that started from a tab it had
   * just opened.
   *
   * So the wrapping happens here, at the single place pages leave the runtime,
   * rather than at each call site. A page that escapes unscoped is the whole
   * bug, and there is exactly one door.
   */
  private scoped(page: Page): Page {
    return scopePage(page);
  }

  /** Open a page in this thread's own context, optionally naming it. */
  async newPage(name?: string): Promise<Page> {
    return this.scoped(await this.runtime.newPage(name));
  }

  /**
   * Every open page in this thread, scoped, in display order.
   *
   * This returns the real pages rather than descriptors, because the
   * documented usage is `await browser.pages()` followed by calling methods on
   * the elements: the skill's "multiple pages" example and the tool
   * description both read `browser.pages()` as a list of tabs, and a caller
   * doing `(await browser.pages())[0].url()` is following the stated contract.
   *
   * It used to return `{name, url, active, index}` records, so that call threw
   * "p.url is not a function". Worse, it was inconsistent with the rest of the
   * surface: `browser.newPage("cart")` hands back a real page, so the same
   * object type a program gets from `newPage` did not match what it got from
   * `pages()`, and the failure looked like a bug in the caller's program
   * rather than in the API.
   *
   * The name and active flag are attached as non-enumerable properties so a
   * program that wants them still can, without them showing up when the list is
   * serialized into the transcript.
   */
  async pages(): Promise<Page[]> {
    return this.runtime.describePages();
  }

  /**
   * Make a page the one a bare `page` means. By name or by index.
   *
   * Three names for one call, deliberately, and the reason is that a model
   * writes what it has been taught. `setActive` is the documented surface a
   * program in the field already uses; `page(name)` is the spelling the browser
   * skill shows in its examples and the one Playwright's own vocabulary
   * suggests; `usePage` reads correctly in a program. All three go to the same
   * runtime call, so there is one behaviour and three doors to it, and a model
   * that reaches for any of them is right rather than nearly right.
   */
  async setActive(selector: string | number | Page): Promise<Page> {
    return this.scoped(await this.runtime.setActive(selector));
  }

  /** The same call, spelled the way the skill's examples show it. */
  async page(selector: string | number | Page): Promise<Page> {
    return this.scoped(await this.runtime.setActive(selector));
  }

  /** The same call under the name that reads best in a program. */
  async usePage(selector: string | number | Page): Promise<Page> {
    return this.scoped(await this.runtime.setActive(selector));
  }

  /** Close a page and forget it, so a name is not left pointing at a corpse. */
  async closePage(page: Page): Promise<void> {
    await this.runtime.closePage(page);
  }

  /** The page a bare `page` currently means. */
  async current(): Promise<Page> {
    return this.scoped((await this.runtime.ensureReady()).page);
  }

  /**
   * The active page, scoped, for the host to root `page` at.
   *
   * Scoped here rather than left raw, because this is what the program's `page`
   * resolves to on every call: handing back the runtime's own handle would let
   * a program that switched tabs walk `page.context().browser().contexts()` out
   * of its thread, which is the isolation the `scoped-page` boundary exists to
   * hold. A fresh proxy per call is deliberate and cheap: the proxy forwards to
   * the same real object, so identity of the *target* is preserved while the
   * guard is applied to whatever page is active at that moment.
   */
  currentPage(): Page | undefined {
    const active = this.runtime.activePage ?? this.initial;
    return active === undefined ? undefined : this.scoped(active);
  }

  /** Write this thread's cookies now, mid-program. */
  async save(): Promise<void> {
    await this.runtime.save();
  }
}

/**
 * The host end of one browser program.
 *
 * Lives for the length of a single program. It owns the handle table (through
 * `RemotePageHost`), the roots the program's proxies resolve against, and the
 * observation helpers, which are the calls that are not Playwright calls and so
 * cannot travel as a method path.
 */
export class BrowserProgramHost {
  private readonly inner: RemotePageHost;

  constructor(
    private readonly runtime: ThreadBrowserRuntime,
    private readonly page: Page,
    private readonly observe: ObserveSurface,
  ) {
    /*
     * The roots, in the order the worker expects them in `browserRoots`.
     *
     * Handle 0 is the page, because that is the one every program starts from
     * and the one whose absence would break everything. The browser and the
     * page list follow.
     */
    const browser = page.context().browser();
    if (!browser) throw new Error("the page has no browser attached");
    /*
     * `browser` roots at the facade, not at the scoped Playwright Browser.
     *
     * The facade is what keeps page naming and active-pinning true: `newPage`
     * through it goes to the runtime, so the page is named and pinned, and
     * `usePage("cart")` can find it later. A raw scoped Browser would refuse
     * `newPage` outright, which is the guard working exactly as designed and
     * exactly the wrong thing to root a program at.
     */
    const facade = new BrowserFacade(runtime);
    /*
     * `page` is resolved on every use rather than bound once.
     *
     * The bare `page` a program reads must be the *active* page, because
     * `browser.setActive(name)` is documented to change what it means. Binding
     * the page object at construction made it the page that existed when the
     * program started, so a program that switched tabs and then used `page`
     * drove the tab it had just left: reproduced with
     * `await browser.setActive('hn'); await page.url()` returning the microsoft
     * page.
     */
    this.inner = new RemotePageHost(() => facade.currentPage() ?? page, {
      browser: facade,
      /*
       * `pages` roots at the *method*, not at the facade.
       *
       * A root is what the program calls: `pages()` invokes the root directly,
       * with no step before it. Rooting at the facade would mean calling the
       * facade object itself, which is not a function, and the program got
       * "this object is not callable" for a call that is documented to work.
       * Bound so it keeps its `this` after crossing the wire.
       */
      pages: () => facade.pages(),
    });
  }

  /** The handles the worker's surface roots at. */
  roots(): Record<string, number> {
    return this.inner.roots();
  }

  /**
   * Answer one call frame.
   *
   * A handle of -1 is not a Playwright call but a call to an observation helper,
   * which the worker sends on the same channel because it is the same round trip
   * and the same failure handling. Keeping it on one channel is what stops the
   * helpers needing their own error path, their own deadline, and their own
   * place in the transcript.
   */
  async call(handle: number, path: Array<{ method: string; args: unknown[] }>): Promise<CallResult> {
    if (handle === -1) return await this.observeCall(path);
    return await this.inner.call(handle, path);
  }

  /**
   * Turn the handle markers in an observation call's arguments into real objects.
   *
   * The observation helpers do not go through `RemotePageHost.call`, so they do
   * not get its argument revival, and `view(locator)` arrived holding
   * `{ __reaperNode: 7 }` where a Locator was meant. The helper then read the
   * whole page instead of the region, which is the exact failure this scoping
   * exists to prevent and is silent: the call succeeds and returns too much.
   */
  private resolveArgs(args: unknown[]): unknown[] {
    return args.map((arg) => this.inner.resolve(arg));
  }

  /** One `view`, `viewChanges` or `screenshot` call from inside the sandbox. */
  private async observeCall(path: Array<{ method: string; args: unknown[] }>): Promise<CallResult> {
    const step = path[0];
    if (!step) return { kind: "error", name: "BadCall", message: "the observation call had no method" };
    const target = this.resolveArgs(step.args)[0] as Page | undefined;
    try {
      switch (step.method) {
        case "view":
          return { kind: "value", value: await this.observe.view(target) };
        case "viewChanges":
          return { kind: "value", value: this.observe.viewChanges() };
        case "screenshot":
          return { kind: "value", value: await this.observe.screenshot(target) };
        default:
          /*
           * A screenshot is the only helper that returns an image, and an
           * unknown name here is a bug in the injected source rather than
           * something the model did, so it is worth saying so precisely.
           */
          return { kind: "error", name: "UnknownHelper", message: `${step.method} is not an observation helper` };
      }
    } catch (error) {
      return { kind: "error", name: (error as Error).name, message: (error as Error).message };
    }
  }
}
