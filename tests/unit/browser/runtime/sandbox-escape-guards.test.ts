/**
 * The doors a sandboxed program must not be able to open.
 *
 * Every one of these was reproduced from inside the real sandbox by the red-team
 * pass, not found by reading. They are grouped in one file because they share a
 * single root cause: a wrapper that special-cases named properties and forwards
 * everything else. Any fix that adds a name to a list is a fix for today's list.
 *
 * The cases here fall into two kinds:
 *
 *   - a *name* that reaches further than intended (`newPage` on a context,
 *     `newBrowserCDPSession` on a browser, `initial` on the facade);
 *   - a *route* that does not go through names at all (`constructor`,
 *     `Object.getPrototypeOf`), which no list of names can close.
 *
 * Both are refused now. The stubs are enough because the guards live in the
 * proxy, and the proxy is what a program talks to whether or not a browser is
 * behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scopeBrowser, scopeContext, scopeFacade, scopePage } from "../../../../src/browser/scoped-page.js";

/** A page good enough for the guards, with a raw context and browser behind it. */
function fakePage() {
  const rawBrowser = { contexts: () => [] as unknown[], newBrowserCDPSession: async () => ({ send: () => undefined }) };
  const rawContext = { pages: () => [] as unknown[], browser: () => rawBrowser, newPage: async () => ({ raw: true }) };
  return {
    ariaSnapshot: async () => "- page",
    goto: async () => undefined,
    context: () => rawContext,
    browser: () => rawBrowser,
    isClosed: () => false,
  };
}

test("the constructor route to the prototype is refused", () => {
  /*
   * The one that is not a missing name. `page.constructor.prototype` needs no
   * knowledge of the Page API and hands back every method the proxy was trying to
   * guard, callable with the proxy as `this`.
   */
  const scoped = scopePage(fakePage() as never, "t1") as unknown as Record<string, unknown>;
  for (const name of ["constructor", "__proto__", "prototype"]) {
    const read = scoped[name];
    assert.equal(typeof read, "function", `${name} must be answered with a thunk, not the real value`);
    assert.throws(() => (read as () => unknown)(), /prototype chain/, `${name} must refuse when called`);
  }
});

test("Object.getPrototypeOf does not hand back the real prototype", () => {
  /*
   * A different proxy trap from `get`, and the reason the `get` refusal alone
   * was not enough. `Object.getPrototypeOf(page)` returned `Page.prototype`,
   * from which `Page.prototype.context.call(page)` works, because the `get` trap
   * still forwards the internal `_context` field the real method reads.
   */
  const scoped = scopePage(fakePage() as never, "t1");
  const proto = Object.getPrototypeOf(scoped) as Record<string, unknown>;
  assert.equal(proto["context"], undefined, "the real prototype must not be reachable here");
  assert.equal(proto["goto"], undefined);
});

test("a context's newPage returns a scoped page, not the raw one", async () => {
  /*
   * The browser-level `newPage` was refused and the refusal was assumed to cover
   * this one. A context's `newPage` is a different method on a different object,
   * so it fell through and returned a real, unscoped Page, from which the whole
   * chain (`context()`, `browser().contexts()`, another thread's tabs) is open
   * again.
   *
   * Scoped rather than refused, because a fresh page in one's own context is
   * legitimate; the scoping is what makes it safe. The assertion is the property
   * that matters: the object handed back refuses the prototype route, so it is a
   * proxy and not the raw page.
   */
  const context = scopePage(fakePage() as never, "t1").context() as unknown as Record<string, unknown>;
  const created = (await (context["newPage"] as () => Promise<Record<string, unknown>>)()) as Record<string, unknown>;
  assert.equal(typeof created["constructor"], "function");
  assert.throws(() => (created["constructor"] as () => unknown)(), /prototype chain/);
});

test("newBrowserCDPSession is refused on the browser", () => {
  /* It answers Target.getTargets with every tab in the shared Chrome. */
  const browser = scopeBrowser(fakePage().browser() as never, {} as never, "t1") as unknown as Record<string, unknown>;
  assert.throws(() => (browser["newBrowserCDPSession"] as () => unknown)(), /whole browser/);
});

test("the facade answers only its documented surface", () => {
  /*
   * The facade is a plain class handed across as an ordinary object, so every own
   * property was readable by name: `browser.initial` was the raw unscoped Page and
   * `browser.runtime` was the whole runtime. `#` fields close today's two, and the
   * allowlist closes the class, including whatever is added next.
   */
  class Facade {
    #secret = "runtime";
    readonly initial = { raw: "page" };
    newPage() {
      return 1;
    }
    pages() {
      return 2;
    }
  }
  const scoped = scopeFacade(new Facade()) as unknown as Record<string, unknown>;
  assert.equal((scoped["newPage"] as () => number)(), 1, "the documented surface still works");
  assert.equal((scoped["pages"] as () => number)(), 2);
  for (const name of ["initial", "secret", "runtime", "constructor"]) {
    assert.throws(
      () => (scoped[name] as () => unknown)(),
      /not part of the browser surface|prototype chain/,
      `${name} must not be reachable`,
    );
  }
});

test("scopeContext is exported for the refusal test to reach", () => {
  /* A one-line guard so the import above cannot silently become unused. */
  assert.equal(typeof scopeContext, "function");
});
