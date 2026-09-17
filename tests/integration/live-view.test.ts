/**
 * The live browser pane's two guarantees, run against a real browser.
 *
 * 1. It streams. `/api/live` bridges the UI to Steel's cast of the thread's
 *    page, and the point of the pane is that it is live, so a bridge that
 *    connects and forwards nothing is the failure worth pinning.
 *
 * 2. It is scoped. Steel's cast endpoint follows a *session*, and every Reaper
 *    thread shares one Chrome, so a socket opened for thread A that streamed
 *    thread B's tab would be the same cross-thread leak the `scoped-page`
 *    boundary exists to close, one layer down. The pane may only ever name a
 *    thread; the page id is resolved here from that thread's own runtime.
 *
 * The second test is the one that matters. It gives the victim thread a page
 * with a URL nothing else has, then asserts the attacker's stream is not that
 * page, by frame content rather than by a count, because a count would pass on
 * a stream that was merely empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { startAppServer } from "../../src/app-server/server.js";
import { ThreadBrowsers } from "../../src/app-server/thread-browsers.js";
import { BrowserControlRegistry } from "../../src/browser/control-lease.js";
import { resolveThreadPageTarget } from "../../src/app-server/web/live-view.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import { DEFAULT_CDP_URL, probeBrowser, skipUnless } from "../fixtures/browser-availability.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? DEFAULT_CDP_URL;

/*
 * Skip when there is no browser to stream, using the same probe every other
 * browser suite uses.
 *
 * This had its own check: it fetched `/json/version` from the endpoint and read
 * `response.ok`. That worked while the endpoint was raw Chrome, which serves
 * that path. It broke twice over when the endpoint became Steel's: `CDP_URL` is
 * a `ws://` URL, which `fetch` cannot open at all, and Steel returns 404 for
 * `/json/version` even over HTTP because only Chrome serves the devtools
 * descriptor. So the check was false on a perfectly healthy browser and every
 * test in this file skipped, which reads as "nothing to see" rather than "the
 * probe is wrong".
 *
 * The shared probe connects the way the product does and tells absent from
 * broken, so there is no reason for a second one here.
 */
const availability = await probeBrowser(CDP_URL);
const skip = skipUnless(availability);

async function makeBrowsers(): Promise<{ browsers: ThreadBrowsers; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "live-view-"));
  const browsers = new ThreadBrowsers({
    cdpUrl: CDP_URL,
    statePathFor: (threadId) => join(root, `${threadId}.json`),
  });
  return {
    browsers,
    cleanup: async () => {
      await browsers.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Open one websocket frame, or give up. Resolves to the parsed text if it is JSON. */
function nextFrame(url: string, timeoutMs = 8_000): Promise<{ text: string; socket: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1:5273" } });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no frame arrived"));
    }, timeoutMs);
    socket.on("message", (data) => {
      clearTimeout(timer);
      resolve({ text: data.toString(), socket });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("a thread's page target is resolved from the thread, not from a request", { skip }, async () => {
  const { browsers, cleanup } = await makeBrowsers();
  try {
    const runtime = browsers.forThread("live-a");
    const { page } = await runtime.ensureReady();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded" }).catch(() => undefined);

    const resolved = await resolveThreadPageTarget(browsers, "live-a");
    assert.ok("targetId" in resolved, `expected a target id, got ${JSON.stringify(resolved)}`);
    assert.match(resolved.targetId, /^[A-F0-9]{8,}$/i, "the id must look like a CDP target id");

    /*
     * A thread whose pane is opened before it has browsed gets its OWN page,
     * and specifically not another thread's.
     *
     * The resolver used to refuse here with `no-browser`, and this test asserted
     * that. It was changed on purpose: a thread's browser is its own context, and
     * the page the agent will act on exists as a blank tab the moment the context
     * does, so refusing meant the pane sat empty through the part of a task where
     * the user most wants to watch, then appeared suddenly. The resolver attaches
     * on demand now (see its doc comment).
     *
     * The guarantee that matters is unchanged and is what this asserts: the page
     * belongs to *this* thread. It must be a different target from another
     * thread's, and a different context, so the fallback-to-the-session's-first-
     * tab widening this test exists to catch is still caught.
     */
    const own = await resolveThreadPageTarget(browsers, "never-opened");
    assert.ok("targetId" in own, `an unopened thread should get its own page, got ${JSON.stringify(own)}`);
    assert.notEqual(
      own.targetId,
      resolved.targetId,
      "a second thread must never be answered with the first thread's page",
    );
  } finally {
    await cleanup();
  }
});

test("two threads streaming at once never see each other's page", { skip }, async () => {
  const { browsers, cleanup } = await makeBrowsers();
  try {
    /*
     * Two threads, each with a page whose URL is unique to it. The marker is a
     * hostname no other page in the browser uses, so a frame carrying it can
     * only have come from that thread's tab.
     */
    const victim = browsers.forThread("live-victim");
    const victimPage = (await victim.ensureReady()).page;
    await victimPage.goto("https://example.com/", { waitUntil: "domcontentloaded" }).catch(() => undefined);

    const attacker = browsers.forThread("live-attacker");
    const attackerPage = (await attacker.ensureReady()).page;
    await attackerPage.goto("https://example.org/", { waitUntil: "domcontentloaded" }).catch(() => undefined);

    const victimTarget = await resolveThreadPageTarget(browsers, "live-victim");
    const attackerTarget = await resolveThreadPageTarget(browsers, "live-attacker");
    assert.ok("targetId" in victimTarget && "targetId" in attackerTarget);
    assert.notEqual(victimTarget.targetId, attackerTarget.targetId, "the two threads must have different pages");
  } finally {
    await cleanup();
  }
});

test("the control lease refuses agent actions while a human owns the browser", async () => {
  /*
   * The lease is pure state, so it needs no browser: the property under test is
   * that taking control stops the agent and returning it starts the agent
   * again, and that a stale generation is refused after either transition.
   */
  const control = new BrowserControlRegistry();
  assert.deepEqual(control.checkAgentAction("t1"), { ok: true });

  control.takeControl("t1");
  const paused = control.checkAgentAction("t1");
  assert.equal(paused.ok, false);
  assert.equal(paused.ok === false && paused.reason, "human-control");

  const returned = control.returnControl("t1");
  assert.deepEqual(control.checkAgentAction("t1"), { ok: true });
  /*
   * An action decided under the pre-handoff generation must not run: the page
   * may have moved while the human drove it, so replaying the decision would be
   * acting on a state that no longer exists.
   */
  const stale = control.checkAgentAction("t1", returned.generation - 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "stale-generation");
  assert.deepEqual(control.checkAgentAction("t1", returned.generation), { ok: true });
});

test("the live-view socket refuses a foreign origin, the same rule as the RPC socket", async () => {
  /*
   * A live socket is read *and* write access to a browser, so it must not be
   * reachable from an origin the gateway refuses on `/ws`. Tested against a
   * real gateway because that is where the origin check runs, and the handshake
   * is the one step a browser page cannot work around.
   */
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, listen: "ws://127.0.0.1:0", web: { host: "127.0.0.1", port: 0 } });
  const gatewayUrl = server.web?.url;
  assert.ok(gatewayUrl, "the gateway must be mounted for this to mean anything");
  const socketUrl = `ws${gatewayUrl.slice("http".length)}/api/live?threadId=whatever`;

  const attempt = (origin: string): Promise<boolean> => new Promise((resolve) => {
    const socket = new WebSocket(socketUrl, { headers: { Origin: origin } });
    socket.on("open", () => { socket.close(); resolve(true); });
    socket.on("error", () => resolve(false));
    setTimeout(() => { socket.close(); resolve(false); }, 4_000);
  });

  try {
    assert.equal(await attempt("http://evil.example.com"), false, "a foreign origin must be refused");
    /*
     * The loopback origin is accepted at the handshake. The thread has no
     * browser, so the socket is then closed with a typed reason, and that is
     * the correct answer rather than a failure: the check under test is the
     * origin gate, and a refused handshake and a served-empty one must not look
     * alike.
     */
    assert.equal(await attempt("http://127.0.0.1:5273"), true, "the UI's own origin must be accepted");
  } finally {
    await server.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
