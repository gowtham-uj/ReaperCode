/**
 * Telling a call from a property read, and keeping arguments whole over the wire.
 *
 * Two bugs from one live mission, both of which made a documented control look
 * present and do nothing.
 *
 * `page.recover()` sent a step named `recover` with no arguments, which is
 * byte-identical to the property read `page.recover`. The host resolved it as a
 * property, got `undefined`, and answered `undefined` — so the agent's call
 * succeeded and did nothing, and it concluded "recover isn't a function returning
 * promise; it's a no-op" before abandoning the control.
 *
 * A RegExp went through the generic object walk, and `Object.keys(/x/)` is empty,
 * so `waitForURL(/secure/)` sent `{}` and Playwright rejected it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RemotePageHost } from "../../../src/browser/remote-page.js";
import { BROWSER_PROGRAM_PARAMS } from "../../../src/browser/remote-page-source.js";
import { PROGRAM_PARAMS } from "../../../src/tools/browser/execute-browser-use.js";

test("calling a name that is not a method fails, instead of returning undefined", () => {
  /*
   * The exact shape that cost the agent its recovery path: a zero-argument call
   * on a property that does not exist. Before the call flag it returned
   * `undefined` and looked like success.
   */
  const page = { url: () => "https://x", title: () => "t" };
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  return host
    .call(0, [{ method: "recover", args: [], called: true }])
    .then((result) => {
      assert.equal(result.kind, "error", "a call to a missing method is an error");
      assert.match(String((result as { message: string }).message), /recover is not a method/);
      // And the message says what to do about it, because "is not a method" alone
      // leaves a model guessing which names exist.
      assert.match(String((result as { message: string }).message), /tool description/i);
    });
});

test("reading a property that does not exist still answers undefined", () => {
  // The behaviour the call flag must not break: `if (pages.length)` and
  // `locator.foo` are reads, and refusing them would break ordinary programs.
  const page = { url: () => "https://x" };
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  return host.call(0, [{ method: "notAThing", args: [] }]).then((result) => {
    assert.equal(result.kind, "value");
    assert.equal((result as { value: unknown }).value, undefined);
  });
});

test("calling a real method still works, with and without arguments", () => {
  const page = {
    url: () => "https://example.com",
    click: (selector: string) => `clicked:${selector}`,
  };
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  return Promise.all([
    host.call(0, [{ method: "url", args: [], called: true }]),
    host.call(0, [{ method: "click", args: ["#go"], called: true }]),
  ]).then(([noArgs, withArgs]) => {
    assert.equal((noArgs as { value: unknown }).value, "https://example.com");
    assert.equal((withArgs as { value: unknown }).value, "clicked:#go");
  });
});

test("a RegExp argument reaches the host as a RegExp", () => {
  /*
   * The fix is on both sides: the sandbox sends source and flags, the host
   * rebuilds. This checks the host half against the marker the sandbox produces.
   */
  let received: unknown;
  const page = { waitForURL: (target: unknown) => { received = target; return "ok"; } };
  const host = new RemotePageHost(() => page as never, { browser: {} as never });

  return host
    .call(0, [{ method: "waitForURL", args: [{ __reaperRegExp: true, source: "secure", flags: "i" } as never], called: true }])
    .then(() => {
      assert.ok(received instanceof RegExp, "the host reconstructed a real RegExp");
      assert.equal((received as RegExp).source, "secure");
      assert.equal((received as RegExp).flags, "i");
      assert.equal((received as RegExp).test("SECURE area"), true, "and it behaves like one");
    });
});

test("the tool and the sandbox bind the same parameter names", () => {
  /*
   * The drift that produced "recover is not defined". There were two lists, a
   * comment saying they must agree, and nothing checking. One is now imported
   * from the other, and this is the assertion that keeps it that way.
   */
  assert.deepEqual(
    [...PROGRAM_PARAMS],
    [...BROWSER_PROGRAM_PARAMS],
    "the program's parameters are the sandbox's, not a second copy of them",
  );
  for (const name of ["recover", "capabilities", "downloadAfter", "pages"]) {
    assert.ok(PROGRAM_PARAMS.includes(name as never), `${name} must be reachable from a program`);
  }
});
