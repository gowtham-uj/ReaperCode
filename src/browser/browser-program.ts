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
  constructor(private readonly runtime: ThreadBrowserRuntime) {}

  /** Open a page in this thread's own context, optionally naming it. */
  async newPage(name?: string): Promise<Page> {
    return await this.runtime.newPage(name);
  }

  /** Every open page, with its name and whether it is the active one. */
  pages(): Array<{ name: string | undefined; url: string; active: boolean; index: number }> {
    return this.runtime.pagesForDisplay();
  }

  /** Make a page the one a bare `page` means. By name or by index. */
  async usePage(selector: string | number): Promise<Page> {
    return await this.runtime.setActive(selector);
  }

  /** Close a page and forget it, so a name is not left pointing at a corpse. */
  async closePage(page: Page): Promise<void> {
    await this.runtime.closePage(page);
  }

  /** The page a bare `page` currently means. */
  async current(): Promise<Page> {
    return (await this.runtime.ensureReady()).page;
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
    this.inner = new RemotePageHost(page, {
      browser: new BrowserFacade(runtime),
      pages: new BrowserFacade(runtime),
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

  /** One `view`, `viewChanges` or `screenshot` call from inside the sandbox. */
  private async observeCall(path: Array<{ method: string; args: unknown[] }>): Promise<CallResult> {
    const step = path[0];
    if (!step) return { kind: "error", name: "BadCall", message: "the observation call had no method" };
    const target = step.args[0] as Page | undefined;
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
