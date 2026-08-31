/**
 * The BFF's single durable connection to the app-server.
 *
 * `src/app-server/auth.ts:24` rejects any upgrade carrying an `Origin` header
 * unless `allowBrowserOrigins` is set, and every browser sends one. That is not
 * an obstacle to work around — it is the trust boundary. This process is the
 * only thing that speaks raw app-server protocol, and it holds the bearer
 * token. Never enable `allowBrowserOrigins`.
 */

import { WebSocket } from "ws";

import { JsonRpcClient } from "../../shared/src/jsonrpc-client.js";
import { nodeTransport } from "../../shared/src/node-transport.js";

export interface AppServerLinkOptions {
  url: string;
  authToken?: string;
  clientName?: string;
}

export interface AppServerLink {
  client: JsonRpcClient;
  capabilities: Record<string, unknown>;
  close(): void;
}

export async function connectToAppServer(options: AppServerLinkOptions): Promise<AppServerLink> {
  const socket = new WebSocket(options.url, {
    headers: options.authToken ? { authorization: `Bearer ${options.authToken}` } : {},
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  const client = new JsonRpcClient(nodeTransport(socket as never));
  const result = await client.call<{ capabilities?: Record<string, unknown> }>("initialize", {
    protocolVersion: 1,
    clientInfo: { name: options.clientName ?? "reaper-web-bff", version: "0.1.0" },
    capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
  });

  return {
    client,
    capabilities: result.capabilities ?? {},
    close: () => client.close(1000, "BFF shutting down"),
  };
}
