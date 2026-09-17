/**
 * Steel is the only path to the browser.
 *
 * Reaper does not launch Chrome and does not connect to it. Steel runs Chrome
 * as its child and proxies CDP on its own API port; the endpoint the browser
 * tool attaches to has to be that one. These tests pin the two ports that are
 * definitely not Steel's managed endpoint, and the one that is, so the rule
 * survives the next time a default moves.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNotRawChrome,
  assertSteelManagedEndpoint,
  isRawChromeEndpoint,
  NotSteelEndpointError,
  STEEL_DEFAULT_PORT,
} from "../../../src/browser/steel-endpoint.js";

test("Chrome's debugging port and Steel's redirect to it are recognised", () => {
  assert.equal(isRawChromeEndpoint("http://127.0.0.1:9222"), true);
  assert.equal(isRawChromeEndpoint("ws://127.0.0.1:9222/devtools/browser/abc"), true);
  assert.equal(isRawChromeEndpoint("http://127.0.0.1:9223"), true);
  // A remote host on the same port is still raw Chrome.
  assert.equal(isRawChromeEndpoint("ws://chrome.internal:9222"), true);
});

test("Steel's managed endpoint is not raw Chrome", () => {
  assert.equal(isRawChromeEndpoint(`ws://127.0.0.1:${STEEL_DEFAULT_PORT}`), false);
  assert.equal(isRawChromeEndpoint("ws://steel.internal:8000"), false);
  // No port means the scheme default, which is never Chrome's devtools port.
  assert.equal(isRawChromeEndpoint("ws://127.0.0.1"), false);
  assert.equal(isRawChromeEndpoint(undefined), false);
});

test("attaching to raw Chrome is refused with a message that names the fix", () => {
  assert.throws(
    () => assertSteelManagedEndpoint("http://127.0.0.1:9222"),
    (error: unknown) => {
      assert.ok(error instanceof NotSteelEndpointError);
      assert.match((error as Error).message, /9222/);
      assert.match((error as Error).message, /Steel/);
      assert.match((error as Error).message, /browserCdpUrl/);
      return true;
    },
  );
  assert.throws(() => assertSteelManagedEndpoint("ws://127.0.0.1:9223"), NotSteelEndpointError);
});

test("Steel's endpoint and an unrecognised port are allowed through", () => {
  // The configured default.
  assert.doesNotThrow(() => assertSteelManagedEndpoint(`ws://127.0.0.1:${STEEL_DEFAULT_PORT}`));
  // A Steel on another port or host cannot be told apart from a remote
  // something-else, so it is allowed: the guard refuses what it can prove wrong.
  assert.doesNotThrow(() => assertSteelManagedEndpoint("ws://steel.example.com:8080"));
});

test("the identity probe recognises Chrome on a non-standard port", async () => {
  /*
   * The port check cannot see this case: a Chrome proxy, a tunnel, or a
   * non-default deployment puts Chrome on a port that is not 9222/9223. The
   * probe asks the endpoint instead of guessing, using the one path Chrome
   * answers and Steel does not. A local server that answers with Chrome's
   * descriptor stands in for that endpoint.
   */
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "Chrome/153.0.0.0", "Protocol-Version": "1.3" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      () => assertNotRawChrome(`ws://127.0.0.1:${port}`, 2_000),
      (error: unknown) => {
        assert.ok(error instanceof NotSteelEndpointError);
        assert.match((error as Error).message, /Chrome\/153/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the identity probe passes an endpoint that is not Chrome", async () => {
  /*
   * A 404, a non-JSON body, an unreachable host: none of these are evidence of
   * Chrome, and refusing them would break Steel Cloud behind auth or a Steel
   * that is still starting. The probe must let them through so the attach
   * reports the real problem.
   */
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end(JSON.stringify({ message: "Route GET:/json/version not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // A 404 is what Steel itself returns for this path.
    await assert.doesNotReject(() => assertNotRawChrome(`ws://127.0.0.1:${port}`, 2_000));
    // And a port with nothing on it is not Chrome either.
    await assert.doesNotReject(() => assertNotRawChrome("ws://127.0.0.1:1", 500));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the guard and the sandbox guard agree on the port numbers", async () => {
  /*
   * `guard.ts` cannot import this module: it is stringified into the worker,
   * where a module-scope name would be undefined. So the port list is written
   * down twice and this test is what keeps the two copies honest. If they
   * drift, a program could reach raw Chrome through `connectOverCDP` even
   * though the attach path refuses it.
   */
  const { GUARD_SOURCE } = await import("../../../src/tools/code/guard.js");
  for (const port of [9222, 9223]) {
    assert.match(GUARD_SOURCE, new RegExp(`\\b${port}\\b`), `guard source should mention ${port}`);
  }
  // And the endpoints this module refuses are exactly those the guard blocks.
  for (const port of [9222, 9223]) {
    assert.equal(isRawChromeEndpoint(`ws://127.0.0.1:${port}`), true);
  }
});
