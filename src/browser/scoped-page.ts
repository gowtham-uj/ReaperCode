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
 * It is **not a security boundary** against a script that goes looking. This is
 * JavaScript running inside the same process, and a determined script can reach
 * the real objects through a prototype, a bound method, or the constructor
 * chain. The kernel-level version of this is one browser process per thread,
 * which costs a Chrome per thread and is a decision nobody has taken.
 *
 * The standard it does hold is that the *ordinary* API cannot widen. That
 * standard was missed once and it mattered: `page`, `context` and `contexts`
 * were wrapped, but `locator("body").page()`, `mainFrame().page()` and
 * `frames()[0].page()` all returned the raw page, and `context().newCDPSession()`
 * reached every target in the shared browser. None of those is a deliberate
 * act; they are how Playwright is normally used, and a sandboxed program
 * reached another thread's tabs with them. So the accessors that hand back an
 * object (locators, frames, pages, contexts, the browser) are all wrapped, and
 * the one accessor with no scoped form (`newCDPSession`) is refused with a
 * message naming the scoped alternative rather than silently returning
 * something dangerous.
 *
 * The honest guarantee is therefore narrower than "cannot escape" and stronger
 * than "helps with mistakes": every documented and idiomatic accessor returns a
 * scoped object, and the deliberate ways around it are the ones a same-process
 * guard cannot close.
 */

import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright";

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
       * The escape hatches that hand back an unscoped object, closed by
       * wrapping the return value rather than the accessor.
       *
       * All three were confirmed to reach the raw page from a sandboxed
       * program: `locator("body").page()`, `mainFrame().page()` and
       * `frames()[0].page()` each returned the real `_Page`, and from there the
       * full chain (`context().browser().contexts()[0].pages()`) was every
       * thread's pages again. This is ordinary Playwright, not an adversarial
       * construction: `locator.page()` is how a program gets back to the page
       * from a locator it was passed.
       *
       * The `get` trap forwarded every unnamed property, so a Locator or Frame
       * came back raw and the scoping stopped at one hop. Wrapping the result
       * here means the same class of call keeps working and the object it
       * returns is still scoped.
       */
      if (property === "locator") {
        return (...args: unknown[]) => scopeLocator(
          (target.locator as (...a: unknown[]) => unknown).apply(target, args) as Locator,
        );
      }
      if (property === "getByRole" || property === "getByText" || property === "getByLabel"
        || property === "getByPlaceholder" || property === "getByTestId" || property === "getByTitle"
        || property === "getByAltText") {
        return (...args: unknown[]) => scopeLocator(
          (target[property] as (...a: unknown[]) => unknown).apply(target, args) as Locator,
        );
      }
      if (property === "mainFrame") {
        return () => scopeFrame(target.mainFrame());
      }
      if (property === "frames") {
        return () => target.frames().map((frame) => scopeFrame(frame));
      }
      /*
       * `newCDPSession` opens a raw protocol connection, and a CDP session is
       * browser-wide no matter which page it was opened on: it answered
       * `Target.getTargets` with every target in the shared Chrome, which is
       * every thread's tabs, and can drive any of them.
       *
       * Refused rather than scoped because there is no scoped form of it. A
       * program that needs a specific capability (cookies, headers, network)
       * has a first-class Playwright call for it, and those go through the
       * scoped objects above. A raw session is the one thing here that cannot
       * be narrowed, so it is the one thing the thread does not get.
       */
      if (property === "newCDPSession") {
        return () => {
          throw new Error(
            "page.context().newCDPSession(page) opens a connection to the whole browser, which this thread does not own. " +
            "Use the Playwright methods for what you need instead: `context.addCookies`/`context.cookies`, `page.setExtraHTTPHeaders`, or `page.route` for network interception.",
          );
        };
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
 * Wrap a Locator so `page()`, `frameLocator()` and frame access stay scoped.
 *
 * A Locator is the object a program most often holds on to, and it carries two
 * ways back up: `page()` returns the page it resolves in, and a `frameLocator`
 * or `contentFrame()` returns a Frame, which also has `page()`. Both are wrapped
 * so the chain cannot reach past the thread at any hop.
 *
 * The locator's own methods are forwarded unchanged, because a locator's job is
 * to be called and chained; only the two that produce a page or frame are
 * intercepted.
 */
export function scopeLocator(locator: Locator): Locator {
  return new Proxy(locator, {
    get(target, property, receiver) {
      if (property === "page") return () => scopePage(target.page());
      if (property === "frameLocator") {
        return (...args: unknown[]) => scopeLocator(
          (target.frameLocator as (...a: unknown[]) => unknown).apply(target, args) as Locator,
        );
      }
      /*
       * `contentFrame` returns a promise, so the wrap happens on resolution.
       * Cast because the DOM-side `Locator` and the `FrameLocator` both appear
       * in this branch's types and only one of them declares it.
       */
      if (property === "contentFrame") {
        return async () => {
          const frame = await (target as unknown as { contentFrame(): Promise<Frame | null> }).contentFrame();
          return frame ? scopeFrame(frame) : frame;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Wrap a Frame so `page()` and nested frame access stay scoped.
 *
 * `page.mainFrame().page()` and `page.frames()[0].page()` both returned the raw
 * page before this existed, from a sandboxed program, which is the whole
 * boundary gone in one ordinary call.
 */
export function scopeFrame(frame: Frame): Frame {
  return new Proxy(frame, {
    get(target, property, receiver) {
      if (property === "page") return () => scopePage(target.page());
      if (property === "childFrames") return () => target.childFrames().map((child) => scopeFrame(child));
      if (property === "locator") {
        return (...args: unknown[]) => scopeLocator(
          (target.locator as (...a: unknown[]) => unknown).apply(target, args) as Locator,
        );
      }
      if (property === "frameLocator") {
        return (...args: unknown[]) => scopeLocator(
          (target.frameLocator as (...a: unknown[]) => unknown).apply(target, args) as Locator,
        );
      }
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
      /*
       * `newCDPSession` is refused here, not only on the page.
       *
       * The page-side guard alone was not enough: `page.context()` returns a
       * scoped context, and a scoped context still forwarded every unnamed
       * property, so `page.context().newCDPSession(page)` opened the raw
       * protocol connection anyway. Verified: it answered `Target.getTargets`
       * with every target in the shared browser. A context is the more natural
       * place to reach for it, so this is where it most needs to be closed.
       */
      if (property === "newCDPSession") {
        return () => {
          throw new Error(
            "context.newCDPSession(page) opens a connection to the whole browser, which this thread does not own. " +
            "Use the Playwright methods for what you need instead: `context.addCookies`/`context.cookies`, `page.setExtraHTTPHeaders`, or `page.route` for network interception.",
          );
        };
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
