/**
 * A client attached to an app-server in another process.
 *
 * The same protocol as the in-process case, over a real socket. `--connect`
 * exists so the CLI can drive the *same* long-lived server the web UI is
 * looking at: the thread it starts is one the browser can see, and a thread the
 * browser started can be continued from a terminal. In-process cannot do that,
 * because its server lives and dies with the command.
 *
 * `nodeTransport` from `web/shared` is used rather than a hand-rolled adapter.
 * It was written for exactly this and had no callers; it is imported by path
 * because `web/shared/src/index.ts` deliberately does not re-export it, so a
 * browser bundle can never pull `ws` in through the barrel.
 */
import WebSocket from "ws";

import { JsonRpcClient } from "../../web/shared/src/jsonrpc-client.js";
import { nodeTransport } from "../../web/shared/src/node-transport.js";

export interface RemoteClientOptions {
  url: string;
  /** Sent as `Authorization: Bearer <token>` on the upgrade, the shape
   *  `app-server/auth.ts` expects. */
  authToken?: string;
  /** Cap on the upgrade handshake, so an unreachable host fails in seconds
   *  rather than appearing to hang. */
  timeoutMs?: number;
}

export interface RemoteClient {
  client: JsonRpcClient;
  dispose(): void;
}

export async function connectRemote(options: RemoteClientOptions): Promise<RemoteClient> {
  const socket = new WebSocket(options.url, {
    ...(options.authToken ? { headers: { authorization: `Bearer ${options.authToken}` } } : {}),
    handshakeTimeout: options.timeoutMs ?? 10_000,
  });

  await new Promise<void>((resolve, reject) => {
    /*
     * `error` and `open` can both fire, and Node's WebSocket emits `error`
     * before `close` on a refused connection. Settling only once keeps a
     * failure from being reported twice, or from resolving after it rejected.
     */
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    socket.once("error", (error: Error) => {
      fail(`Could not reach the app-server at ${options.url}: ${error.message}`);
    });
    socket.once("unexpected-response", (_request, response) => {
      /*
       * A non-loopback listener refuses an unauthenticated or wrongly
       * authenticated upgrade by closing rather than by responding, so this
       * path carries the two failures a user actually hits. Naming them here
       * beats surfacing a bare socket error.
       */
      const status = response.statusCode ?? 0;
      fail(
        status === 401 || status === 403
          ? `The app-server at ${options.url} rejected the token (HTTP ${status}). Pass --auth-token or --auth-token-file.`
          : `The app-server at ${options.url} refused the connection (HTTP ${status}).`,
      );
    });
  });

  return {
    client: new JsonRpcClient(nodeTransport(socket)),
    // 1000 is a normal closure; a stricter code would look like a failure to
    // the server's logs for what is an ordinary disconnect.
    dispose: () => socket.close(1000, "CLI finished"),
  };
}
