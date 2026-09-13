/**
 * The preview proxy is where the BFF touches a port the *agent* opened, so its
 * tests exercise the real proxy path rather than only the parser: a live dev
 * server on a loopback port, a real BFF in front of it, and a plain HTTP
 * client.
 *
 * The assertions are about the trust boundary: the upstream sees a hardcoded
 * loopback host, never one from the request; the response loses framing and
 * cookie headers; and a request bearing a BFF-origin cookie does not leak that
 * cookie into the dev server.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";

import { ProviderCredentialStore } from "../../src/config/provider-credentials.js";
import { startAppServer, type RunningAppServer } from "../../src/app-server/server.js";
import type { RunningBrowserGateway } from "../../src/app-server/web/gateway.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";

function engineResult(message: string): RuntimeEngineResult {
  return {
    assistantMessage: message,
    toolResults: [],
    events: [],
    trajectoryPath: "",
    state: {} as RuntimeEngineResult["state"],
  };
}

async function listenOnLoopback(
  handler: (request: IncomingMessage) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    handler(request);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

async function startStack(): Promise<{ gateway: RunningBrowserGateway; stop(): Promise<void> }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-preview-"));
  // The gateway is mounted in the app-server process itself. The turn runner is
  // never invoked — no turn runs.
  const appServer: RunningAppServer = await startAppServer({
    workspaceRoot: workspace,
    listen: "ws://127.0.0.1:0",
    turnRunner: async () => engineResult("unused"),
    credentials: new ProviderCredentialStore({ home: workspace }),
    web: { host: "127.0.0.1", port: 0 },
  });
  return {
    gateway: appServer.web!,
    async stop() {
      await appServer.stop();
    },
  };
}

test("the proxy strips framing and cookie headers and hardcodes the upstream host", async () => {
  const upstream: Array<{ host?: string | undefined; path?: string | undefined; cookie?: string | undefined; authorization?: string | undefined }> = [];

  const { server: devServer, port } = await listenOnLoopback((request) => {
    upstream.push({
      host: request.headers.host,
      path: `${request.url ?? ""}`,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
  });

  const stack = await startStack();
  try {
    const response = await fetch(`${stack.gateway.url}/preview/${port}/hello?x=1`, {
      headers: {
        // A cookie for the BFF's own origin must never be replayed into the
        // dev server, whose loopback port is not trusted with it.
        cookie: "bff_session=secret",
        authorization: "Bearer bff-token",
      },
    });

    assert.equal(response.status, 200, `proxy did not pass through: ${response.status}`);
    assert.equal(response.headers.get("x-frame-options"), null, "x-frame-options must be stripped");
    assert.equal(response.headers.get("set-cookie"), null, "set-cookie must be stripped");

    assert.equal(upstream.length, 1, "the dev server should have received exactly one request");
    assert.equal(upstream[0]?.host, `127.0.0.1:${port}`, "upstream Host must be hardcoded to loopback");
    assert.equal(upstream[0]?.path, "/hello?x=1", "the path and query must be preserved");
    assert.equal(upstream[0]?.cookie, undefined, "the BFF-origin cookie must not leak upstream");
    assert.equal(upstream[0]?.authorization, undefined, "the BFF bearer token must not leak upstream");
  } finally {
    await stack.stop();
    devServer.close();
  }
});

test("a missing dev server answers 502 with a readable body, not a hangup", async () => {
  // Learn a loopback port, then free it so the proxy has a port that is
  // definitely dead.
  const { server: devServer, port } = await listenOnLoopback(() => {});
  await new Promise<void>((resolve) => devServer.close(() => resolve()));

  const stack = await startStack();
  try {
    const response = await fetch(`${stack.gateway.url}/preview/${port}/`);
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.ok(body.includes(`port ${port}`), "the 502 should name the port it failed to reach");
  } finally {
    await stack.stop();
  }
});
