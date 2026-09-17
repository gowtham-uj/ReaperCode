/**
 * The browser's lifetime is not the model's to end.
 *
 * A thread's browser is meant to outlive every call it makes: pages, cookies,
 * logins and the live DOM all live in it, and the runtime has no way to bring
 * them back once the context is gone. So the scoped surface refuses the calls
 * that would destroy it, and allows the ones that manage a page.
 *
 * This was not true before: `page.context().close()` was forwarded to the real
 * context. It did not fail, it *hung*: the promise never settled while the
 * runtime still held the connection, so a step sat until its deadline with no
 * error naming the cause. Measured.
 *
 * These tests use stubs rather than a browser, because what is under test is the
 * guard and not Chrome. The stub records whether the real method was reached,
 * which is the only thing that distinguishes "refused" from "pretended to
 * refuse".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { scopeBrowser, scopeContext, scopePage } from "../../../src/browser/scoped-page.js";

/** A minimal stand-in that records which real methods were reached. */
function stub(object: Record<string, unknown>): { object: Record<string, unknown>; called: string[] } {
  const called: string[] = [];
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    wrapped[key] = typeof value === "function"
      ? (...args: unknown[]) => {
        called.push(key);
        return (value as (...a: unknown[]) => unknown)(...args);
      }
      : value;
  }
  return { object: wrapped, called };
}

function fakeContext(): { ctx: never; called: string[] } {
  const { object, called } = stub({
    close: async () => undefined,
    pages: () => [],
    browser: () => undefined,
    newCDPSession: async () => undefined,
    addCookies: async () => undefined,
    cookies: async () => [],
  });
  return { ctx: object as never, called };
}

function fakeBrowser(context: unknown): { browser: never; called: string[] } {
  const { object, called } = stub({
    close: async () => undefined,
    contexts: () => [context],
    context: () => context,
    newContext: async () => context,
  });
  return { browser: object as never, called };
}

test("closing the context is refused and never reaches the real context", () => {
  const { ctx, called } = fakeContext();
  const scoped = scopeContext(ctx, "t1") as unknown as { close: () => unknown };
  assert.throws(() => scoped.close(), /context\.close\(\)/);
  assert.deepEqual(called, [], "the real close must not have been called");
});

test("closing the browser is refused and never reaches the real browser", () => {
  const { ctx } = fakeContext();
  const { browser, called } = fakeBrowser(ctx);
  const scoped = scopeBrowser(browser, ctx as never, "t1") as unknown as { close: () => unknown };
  assert.throws(() => scoped.close(), /browser\.close\(\)/);
  assert.deepEqual(called, [], "the real close must not have been called");
});

test("closing a page is allowed, because a tab is the model's to manage", () => {
  const closed: string[] = [];
  const page = {
    close: async () => { closed.push("page"); },
    goto: async () => undefined,
    url: () => "https://example.com/",
    context: () => undefined,
  };
  const scoped = scopePage(page as never, "t1") as unknown as { close: () => Promise<void> };
  // No throw: this is the operation that must keep working.
  assert.doesNotThrow(() => void scoped.close());
});

test("the refusal names what to do instead", () => {
  const { ctx } = fakeContext();
  const scoped = scopeContext(ctx, "t1") as unknown as { close: () => unknown };
  try {
    scoped.close();
    assert.fail("should have thrown");
  } catch (error) {
    const message = (error as Error).message;
    // A refusal the model cannot act on is only half a refusal.
    assert.match(message, /page\.close\(\)|closePage/);
    assert.match(message, /cookie|login|page/i);
  }
});
