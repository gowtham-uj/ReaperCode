/**
 * The browser's connection to the app-server's browser gateway.
 *
 * Speaks the same JSON-RPC shape as the app-server, but the gateway is the
 * peer — it multiplexes every tab over one virtual connection and translates
 * approval id spaces. The browser never sees an app-server request id.
 */

import { browserTransport, JsonRpcClient, type ApprovalRequest } from "@reaper/web-shared";

export interface ConnectionHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  onApproval(request: ApprovalRequest): void;
  onApprovalResolved(approvalId: string): void;
  onStatusChange(status: ConnectionStatus): void;
}

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface Connection {
  client: JsonRpcClient;
  tabId: string;
  close(): void;
}

export function connect(url: string, handlers: ConnectionHandlers): Promise<Connection> {
  handlers.onStatusChange("connecting");
  const socket = new WebSocket(url);

  return new Promise((resolve, reject) => {
    let tabId = "";

    socket.addEventListener("error", () => reject(new Error("Could not reach the Reaper app-server")), { once: true });

    socket.addEventListener("open", () => {
      handlers.onStatusChange("open");
      const client = new JsonRpcClient(browserTransport(socket));

      client.onClose(() => handlers.onStatusChange("closed"));

      client.onNotification((method, params) => {
        if (method === "browser/ready") {
          tabId = String(params.tabId ?? "");
          resolve({ client, tabId, close: () => client.close() });
          return;
        }

        if (method === "approval/requested") {
          handlers.onApproval({
            requestId: 0, // The gateway owns request ids; the browser keys on approvalId.
            method: String(params.method ?? ""),
            threadId: String(params.threadId ?? ""),
            ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
            approvalId: String(params.approvalId ?? ""),
            params,
            availableDecisions: Array.isArray(params.availableDecisions)
              ? (params.availableDecisions as string[])
              : ["accept", "decline", "cancel"],
          });
          return;
        }

        // The server settled an approval on its own — a timeout, or the turn
        // aborted. Take the prompt down rather than leave a dead button. The
        // gateway has already translated the app-server's requestId to approvalId.
        if (method === "approval/resolved") {
          handlers.onApprovalResolved(String(params.approvalId ?? ""));
          return;
        }

        handlers.onNotification(method, params);
      });
    });
  });
}
