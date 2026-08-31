/**
 * Node `ws` adapter for `JsonRpcClient`.
 *
 * Used by the test fixture and by the BFF's connection to the app-server.
 * Kept in its own module so browser bundles never pull `ws` in — `index.ts`
 * deliberately does not re-export it.
 */

import type { JsonRpcTransport } from "./jsonrpc-client.js";

/** Structural subset of `ws`'s WebSocket — avoids a type dependency on `ws`. */
export interface NodeWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number, reason: unknown) => void): unknown;
}

export function nodeTransport(socket: NodeWebSocketLike): JsonRpcTransport {
  return {
    send: (data) => socket.send(data),
    onMessage: (handler) => {
      socket.on("message", (data) => handler(String(data)));
    },
    onClose: (handler) => {
      socket.on("close", (code, reason) => handler(code, String(reason ?? "")));
    },
    close: (code, reason) => socket.close(code, reason),
  };
}
