/**
 * The CLI's end of an app-server connection.
 *
 * A client is a peer, not a caller: the server sends approval requests *to* it
 * and blocks the tool call until it answers. So this implements the same
 * `AppServerClientConnection` the browser gateway's virtual connection does,
 * and exposes the same `JsonRpcTransport` shape the browser's `connection.ts`
 * builds over a WebSocket. `CliClient` above it is then identical for both
 * cases, which is the point: `reaper exec run` and the web UI drive the same
 * protocol, so a fix lands once.
 *
 * In-process is the default because it needs no port, no token, and no second
 * process, and because that is already how the browser gateway mounts itself
 * (`server.ts`, `VirtualAppServerConnection`). `--connect` swaps the transport
 * for a real socket and nothing else changes.
 */
import { randomUUID } from "node:crypto";

import { JsonRpcClient, type JsonRpcTransport } from "../../web/shared/src/jsonrpc-client.js";
import type { AppServerClientConnection } from "../app-server/connection.js";
import { AppServerMessageProcessor } from "../app-server/message-processor.js";
import { createAppServerCore, type StartAppServerOptions } from "../app-server/server.js";

/** Frames the server sends that this client cares about by name. */
export const NOTIFICATION = {
  initialized: "initialized",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  reasoningDelta: "item/reasoning/textDelta",
  commandOutputDelta: "item/commandExecution/outputDelta",
  error: "error",
} as const;

/**
 * The in-process half of a connection.
 *
 * Two hats on one object, which is what makes the in-process case work without
 * a socket: the app-server sees it as a client connection and pushes frames
 * into `sendJson`, while the CLI sees it as a transport and reads those frames
 * back out through `onMessage`. `VirtualAppServerConnection` does the same
 * thing with a hub in the middle; here the frames go straight across.
 *
 * Delivery is synchronous by design. The processor writes a response and the
 * client's promise resolves before `sendJson` returns, which is why a CLI turn
 * cannot deadlock waiting on its own request.
 */
export class InProcessConnection implements AppServerClientConnection, JsonRpcTransport {
  readonly id = `cli-${randomUUID()}`;
  readonly subscriptions = new Map<string, () => void>();

  private readonly messageHandlers = new Set<(data: string) => void>();
  private readonly closeHandlers = new Set<(code: number, reason: string) => void>();
  private closed = false;

  /** Set once the core exists. Frames are buffered until then so a `sendJson`
   *  that arrives during construction is not lost. */
  private dispatch: ((value: unknown) => void) | undefined;
  private readonly queued: unknown[] = [];

  attach(dispatch: (value: unknown) => void): void {
    this.dispatch = dispatch;
    for (const value of this.queued.splice(0)) dispatch(value);
  }

  /* ---- AppServerClientConnection: the app-server's view ---- */

  sendJson(value: unknown): boolean {
    if (this.closed) return false;
    if (!this.dispatch) {
      this.queued.push(value);
      return true;
    }
    const text = JSON.stringify(value);
    for (const handler of this.messageHandlers) handler(text);
    return true;
  }

  close(): void {
    this.handleClose(1000, "Client closed");
  }

  /** No socket to ping. The in-process peer cannot be unreachable. */
  heartbeat(): void {}

  /* ---- JsonRpcTransport: the CLI's view ---- */

  send(data: string): void {
    if (this.closed) return;
    const value: unknown = JSON.parse(data);
    if (this.dispatch) this.dispatch(value);
    else this.queued.push(value);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandlers.add(handler);
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler(code, reason);
    this.messageHandlers.clear();
    this.closeHandlers.clear();
  }
}

export interface InProcessClient {
  client: JsonRpcClient;
  dispose(): void;
}

/**
 * An app-server running inside this process, with a client attached to it.
 *
 * `createAppServerCore` builds the manager, router, and processor; adding this
 * connection is the only thing that makes it usable. Nothing binds a port, so
 * two CLI runs cannot collide, and there is no token to manage because there is
 * no network boundary to cross.
 */
export function connectInProcess(options: StartAppServerOptions): InProcessClient {
  const { processor } = createAppServerCore(options);
  const connection = new InProcessConnection();
  processor.addConnection(connection);
  connection.attach((value) => {
    void processor.process(connection, value).catch(() => undefined);
  });
  return {
    client: new JsonRpcClient(connection),
    dispose: () => {
      connection.close();
      processor.removeConnection(connection);
    },
  };
}

