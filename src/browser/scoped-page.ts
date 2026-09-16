/**
 * A page that cannot walk out of its own thread.
 *
 * The hole this closes is one line long and was confirmed by running it, not by
 * reading:
 *
 *     page.context().browser().contexts().flatMap(c => c.pages())
 *
 * Every thread attaches to the same Steel Chrome, so `browser.contexts()` is
 * browser-wide by definition and returns every other thread's contexts. Agent A
 * drove Agent B's page to a different URL with exactly that chain. Our own
 * `browser.pages()` surface was correctly scoped and did not matter, because the
 * raw object behind it offered the way around.
 *
 * A `BrowserContext` gives data isolation: another thread cannot read this
 * thread's cookies. It does not give control isolation, and control isolation is
 * what "an agent must not touch another agent's pages" actually requires.
 *
 * ## What this is and is not
 *
 * It is a wrapper whose `context()` and `contexts()` resolve to this thread's
 * own context and nothing else, so the widening chain dead-ends. Everything a
 * program legitimately does is delegated to the real object, so a page still
 * behaves exactly like a page.
 *
 * It is **not a security boundary**. This is JavaScript running inside the same
 * process, and a determined script can reach the real objects through a
 * prototype, a bound method, or the constructor chain. It is a boundary against
 * the plausible mistake, which is the stance every guard in this codebase takes
 * and states. The kernel-level version of this is one browser process per
 * thread, which costs a Chrome per thread and is a decision nobody has taken.
 *
 * So the honest guarantee is: the built-in accessors cannot widen, and anything
 * that goes around them is a deliberate act rather than an accident.
 */

import type { Browser, BrowserContext, Page } from "playwright";

/**
 * Wrap a page so its context chain stops at this thread.
 *
 * A `Proxy` rather than an object with copied methods, because a page has a
 * large and version-dependent surface and a hand-copied subset would be wrong in
 * a way that fails at the call site rather than here. The proxy forwards
 * everything and intervenes on exactly the four accessors that widen.
 */
export function scopePage(page: Page): Page {
  return new Proxy(page, {
    get(target, property, receiver) {
      if (property === "context") {
        /*
         * The page's own context, scoped. `context()` on a page cannot widen:
         * it returns the context the page belongs to, which is this thread's.
         * It is wrapped anyway so that `page.context().browser()` cannot walk
         * back up to the shared browser.
         */
        return () => scopeContext(target.context());
      }
      /*
       * A function read off the proxy has to be bound to the real target, or
       * Playwright's internal `this` checks fail with a message about an
       * illegal invocation. Bound here rather than left to the caller.
       */
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Wrap a context so it can only ever name itself.
 *
 * `contexts()` returning a one-element array is the important part: a program
 * that enumerates and filters by URL finds only its own pages, so the attack
 * that worked returns nothing rather than another thread's tab.
 */
export function scopeContext(context: BrowserContext): BrowserContext {
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === "browser") {
        /*
         * A browser from this context, scoped. Without this the chain is
         * `page.context().browser().contexts()` and every other context is
         * reachable, which is exactly the attack.
         */
        return () => scopeBrowser(target.browser()!, target);
      }
      if (property === "pages") {
        // The context's own pages, naturally scoped, but their pages are scoped
        // too so a program cannot hold one and walk back up from it.
        return () => target.pages().map((page) => scopePage(page));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Wrap a browser so it sees only one context.
 *
 * This is the accessor the attack used. `contexts()` returns the one context
 * this thread owns, and `context()` returns it or nothing: there is no second
 * argument that produces somebody else's.
 *
 * `newContext()` is deliberately *not* removed, because a program has a
 * legitimate reason to want a clean context and the runtime already gives it a
 * per-thread one. What it cannot do is enumerate contexts it did not make.
 */
export function scopeBrowser(browser: Browser, own: BrowserContext): Browser {
  return new Proxy(browser, {
    get(target, property, receiver) {
      if (property === "contexts") return () => [scopeContext(own)];
      if (property === "context") {
        return (...args: unknown[]) => {
          /*
           * Playwright's `browser.context()` takes no argument and returns the
           * default context, which is the one belonging to whoever created the
           * browser rather than to this thread. Returning this thread's own
           * context is the honest answer to "which context am I in", and it
           * means a program calling it gets something usable rather than
           * somebody else's browser state.
           */
          void args;
          return scopeContext(own);
        };
      }
      if (property === "newContext") {
        // A new context this thread made is this thread's, so it is scoped too.
        return (options?: Parameters<Browser["newContext"]>[0]) => target.newContext(options).then((created) => scopeContext(created));
      }
      /*
       * `newPage` creates a page in the default context, which is not this
       * thread's. Refused rather than silently redirected: a program asking for
       * a bare new page would otherwise get one in a context it does not own,
       * and every later call on it would look like it worked.
       */
      if (property === "newPage") {
        return () => {
          throw new Error(
            "browser.newPage() would open a page in the browser's default context, which belongs to no thread. Use `await browser.newPage(name)` instead, which opens it in this thread's own context.",
          );
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * The page and browser a program is handed, both scoped to one thread.
 *
 * Returned together because they must agree: handing a scoped browser and a raw
 * page would leave the page's context chain open, and the other way round would
 * make the browser's `contexts()` disagree with the page it was given.
 */
export function scopeToThread(page: Page): { page: Page; browser: Browser } {
  return { page: scopePage(page), browser: scopeBrowser(page.context().browser()!, page.context()) };
}
