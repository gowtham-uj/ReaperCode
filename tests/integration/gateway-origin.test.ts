/**
 * The browser gateway's WebSocket accepts the UI and refuses every other page.
 *
 * The hole this pins was a live credential path, verified end to end before the
 * fix. WebSockets are not subject to CORS: a browser sends the handshake from any
 * page regardless of origin, and only the server can refuse it. This listener
 * accepts browser origins on purpose, because it *is* the browser surface, and
 * "accepts browser origins" had been implemented as "accepts any origin".
 *
 * So from `Origin: http://evil.example.com` the full RPC protocol was reachable:
 *
 *   1. open ws://127.0.0.1:<gateway>/ws with a foreign Origin   -> accepted
 *   2. thread/start { cwd: "~/.reaper" }                        -> accepted
 *   3. GET /api/file?threadId=...&path=settings.json            -> 200, contents
 *
 * Step 3 reads whatever the chosen root holds, so the same request against a
 * `providers.json` returns the provider key. The file route was never the
 * problem — `resolveInsideRoot` blocks traversal correctly. The problem was that
 * the root itself was the attacker's to choose, which means confinement to it
 * confines nothing.
 *
 * The fix is at step 1, because that is the only step a browser page cannot work
 * around: the handshake is the one request the server fully controls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { startAppServer } from "../../src/app-server/server.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

/** Try a handshake with one Origin and report whether the server allowed it. */
async function handshake(gatewayUrl: string, origin: string | undefined): Promise<"accepted" | "refused"> {
  return await new Promise((resolve) => {
    const url = `ws${gatewayUrl.slice("http".length)}/ws`;
    const socket = origin === undefined ? new WebSocket(url) : new WebSocket(url, { headers: { Origin: origin } });
    const finish = (result: "accepted" | "refused"): void => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    socket.on("open", () => finish("accepted"));
    socket.on("error", () => finish("refused"));
    setTimeout(() => finish("refused"), 5_000);
  });
}

test("the gateway WebSocket accepts the UI's loopback origin and refuses a foreign one", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, listen: "ws://127.0.0.1:0", web: { host: "127.0.0.1", port: 0 } });
  const gatewayUrl = server.web?.url;
  assert.ok(gatewayUrl, "the gateway must be mounted for this test to mean anything");

  try {
    /*
     * The attack. A page on any origin is what the browser will happily deliver
     * a WebSocket handshake from, so this is the request that had to become
     * refusable.
     */
    assert.equal(
      await handshake(gatewayUrl, "http://evil.example.com"),
      "refused",
      "a page on another origin must not be able to open the RPC socket",
    );
    assert.equal(await handshake(gatewayUrl, "https://attacker.test"), "refused");

    /*
     * And the UI still works, which is the half that makes the guard acceptable.
     * Both spellings of loopback are checked because the Vite dev server and a
     * production host can differ in which one they use.
     */
    assert.equal(await handshake(gatewayUrl, "http://127.0.0.1:5273"), "accepted");
    assert.equal(await handshake(gatewayUrl, "http://localhost:5273"), "accepted");

    /*
     * A client with no Origin at all is not a browser, and it is already inside
     * the loopback boundary this surface trusts. The CLI and the test fixtures
     * connect this way.
     */
    assert.equal(await handshake(gatewayUrl, undefined), "accepted");
  } finally {
    await server.stop();
  }
});
