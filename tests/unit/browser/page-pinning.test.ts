/**
 * `page` does not change under a running program.
 *
 * This is the bug that produced the "the page stopped accepting input" theory,
 * which cost a mission twenty tool calls. The measured shape: a program installed
 * a document listener, clicked, and read its counter back, and got `0`. All three
 * calls went through `page`, and `page` resolved to the runtime's active page on
 * every call, so a re-pin happening between them sent the listener to one page
 * and the click to another.
 *
 * Nothing on the page was broken. The program was talking to two different tabs.
 *
 * The rule these tests pin: the page is fixed for the life of the program, and
 * only the program's own `setActive` or `newPage` may change it. That is exactly
 * what the skill documents, and the two halves pull in opposite directions, so
 * both are asserted.
 *
 * The seam is exercised directly rather than through `BrowserProgramHost`, which
 * needs a real Playwright page with a context and a browser behind it. The logic
 * under test is the resolver the host passes to its `RemotePageHost`, which is
 * three lines and is where the bug was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BrowserFacade } from "../../../src/browser/browser-program.js";
import type { Page } from "playwright";

/**
 * Which page a resolved value is, read by url.
 *
 * Not identity: `BrowserFacade` scopes every page it hands out, and the scope is
 * a proxy, so `===` against the original object is false for the right page. The
 * url is what distinguishes the pages in these tests, so it is what is compared.
 */
function which(page: Page): string {
  return page.url();
}

/** A stand-in page, told apart by its url. */
function fakePage(url: string): Page {
  return { url: () => url, isClosed: () => false } as unknown as Page;
}

/**
 * A runtime whose own active page can be moved from outside a program.
 *
 * That is the point: the test has to re-pin the runtime behind the program's
 * back, which is what a handle reset, a page-list re-read or a health sweep does
 * in production.
 */
function fakeRuntime(pages: Page[]): {
  runtime: Record<string, unknown>;
  /** Move the runtime's active page without the program asking. */
  repinBehindTheProgram: (page: Page) => void;
} {
  let active = pages[0]!;
  return {
    runtime: {
      get activePage() { return active; },
      threadId: "t",
      setActive: async (selector: unknown) => {
        const next = typeof selector === "number" ? pages[selector]! : (selector as Page);
        active = next;
        return next;
      },
      newPage: async () => { active = pages[pages.length - 1]!; return active; },
    },
    repinBehindTheProgram: (page) => { active = page; },
  };
}

test("a runtime re-pin does not move the program's page", () => {
  const a = fakePage("https://a.example/");
  const b = fakePage("https://b.example/");
  const { runtime, repinBehindTheProgram } = fakeRuntime([a, b]);
  let pinned: Page | undefined;
  const pinning = new BrowserFacade(runtime as never, (next) => { pinned = next; });
  const resolve = () => (pinned ??= pinning.currentPage() ?? a);

  assert.equal(which(resolve()), "https://a.example/", "the program starts on the runtime's active page");
  repinBehindTheProgram(b);
  assert.equal(which(resolve()), "https://a.example/", "and a runtime re-pin does not move it");
});

test("the program's own setActive does move the page", async () => {
  const a = fakePage("https://a.example/");
  const b = fakePage("https://b.example/");
  const { runtime } = fakeRuntime([a, b]);
  let pinned: Page | undefined;
  const facade = new BrowserFacade(runtime as never, (next) => { pinned = next; });
  const resolve = () => (pinned ??= facade.currentPage() ?? a);

  assert.equal(which(resolve()), "https://a.example/");
  await facade.setActive(1);
  assert.equal(which(resolve()), "https://b.example/", "setActive re-pins, because that is what it is for");
});

test("opening a page re-pins, because the new tab is the active one", async () => {
  const a = fakePage("https://a.example/");
  const b = fakePage("https://b.example/");
  const { runtime } = fakeRuntime([a, b]);
  let pinned: Page | undefined;
  const facade = new BrowserFacade(runtime as never, (next) => { pinned = next; });
  const resolve = () => (pinned ??= facade.currentPage() ?? a);

  assert.equal(which(resolve()), "https://a.example/");
  await facade.newPage("second");
  assert.equal(which(resolve()), "https://b.example/", "a program that opens a tab means the new one by `page`");
});

test("without a re-pin callback the page stays where it started", () => {
  // The facade is usable without the callback, and in that case nothing should
  // ever move the page: the default must be the safe one.
  const a = fakePage("https://a.example/");
  const b = fakePage("https://b.example/");
  const { runtime, repinBehindTheProgram } = fakeRuntime([a, b]);
  const facade = new BrowserFacade(runtime as never);
  let pinned: Page | undefined;
  const resolve = () => (pinned ??= facade.currentPage() ?? a);

  assert.equal(which(resolve()), "https://a.example/");
  repinBehindTheProgram(b);
  assert.equal(which(resolve()), "https://a.example/");
});
