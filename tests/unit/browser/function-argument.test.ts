/**
 * Passing a function to `evaluate` and `waitForFunction`.
 *
 * Refusing functions is safe but wrong for the model: `page.evaluate(() =>
 * document.title)` is the idiomatic Playwright call, so a tool that rejects it
 * fails the common case. Read from a live mission, where this cost two programs.
 *
 * The conversion happens in the sandbox, where the program is already confined,
 * and what crosses to the host is a string that is never evaluated on the host:
 * Playwright compiles it in the browser. These tests drive the real bridge
 * host with a fake page, so the conversion and the per-method wrapping are
 * checked rather than assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RemotePageHost } from "../../../src/browser/remote-page.js";

/** A stand-in for a Playwright page that records how it was called. */
function fakePage(): { page: Record<string, unknown>; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => (...args: unknown[]): unknown => {
    calls.push({ method, args });
    return `called:${method}`;
  };
  const page = {
    evaluate: record("evaluate"),
    waitForFunction: record("waitForFunction"),
    title: record("title"),
    locator: record("locator"),
  };
  return { page, calls };
}

/** The marker the sandbox sends for a function, built here the way it does. */
function marker(source: string, invoked: boolean): unknown {
  return { __reaperFunctionSource: invoked ? "invoke" : "plain", source };
}

test("an evaluate function is converted to an invoked source string", async () => {
  const { page, calls } = fakePage();
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  // `page.evaluate(() => document.title)` arrives as a marker for a callable.
  await host.call(0, [{ method: "evaluate", args: [marker("() => document.title", true)] }]);

  assert.equal(calls[0]!.method, "evaluate");
  assert.equal(
    calls[0]!.args[0],
    "(() => document.title)()",
    "evaluate runs its string as an expression, so the call has to be in the source",
  );
});

test("a waitForFunction function stays a function string", async () => {
  const { page, calls } = fakePage();
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  await host.call(0, [{ method: "waitForFunction", args: [marker("() => window.ready", true)] }]);

  assert.equal(calls[0]!.method, "waitForFunction");
  assert.equal(
    calls[0]!.args[0],
    "() => window.ready",
    "waitForFunction compiles and calls the string itself, so it must not be wrapped",
  );
});

test("a function body source survives unchanged apart from the wrapper", async () => {
  const { page, calls } = fakePage();
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  const result = await host.call(0, [{ method: "evaluate", args: [marker("function () { return document.forms.length }", true)] }]);
  assert.equal(calls.length, 1, JSON.stringify(result));
  assert.equal(calls[0]!.args[0], "(function () { return document.forms.length })()");
});

test("the conversion does not run anything on the host", async () => {
  /*
   * The whole reason functions were refused: the host used to rebuild them from
   * source with an eval, which was an escape in the app-server process. The
   * replacement must pass a string through and never evaluate it. A source that
   * would have executed at revival time is the test.
   */
  const { page, calls } = fakePage();
  const host = new RemotePageHost(() => page as never, { browser: {} as never });
  const hostile = "(() => { throw new Error('executed on the host') })()";

  // No throw: the string is data, and the fake page never runs it.
  const result = await host.call(0, [{ method: "evaluate", args: [marker(hostile, true)] }]);
  assert.equal(calls.length, 1, JSON.stringify(result));
  assert.equal(typeof calls[0]!.args[0], "string");
});

test("an ordinary string argument is still passed through untouched", async () => {
  const { page, calls } = fakePage();
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  await host.call(0, [{ method: "evaluate", args: ["document.title"] }]);

  assert.equal(calls[0]!.args[0], "document.title", "a plain expression is not wrapped");
});
