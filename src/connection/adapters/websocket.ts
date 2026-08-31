import {
  formatJsonRpcError,
  formatJsonRpcNotifications,
  formatJsonRpcSuccess,
} from "../event-formatter.js";
import { parseJsonRpcRequest } from "../json-rpc.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { describeConnectionError } from "../errors.js";
import { SessionGateway } from "../session-gateway.js";

export class WebSocketAdapter {
  readonly transportKind: TransportKind = "websocket";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: string): Promise<string[]> {
    const rpcRequest = parseJsonRpcRequest(JSON.parse(input));

    try {
      const envelope = parseAgentRequestEnvelope(rpcRequest.params);
      const result = await this.gateway.handleRequest(envelope, "websocket");
      const notifications = formatJsonRpcNotifications(result.events);
      const response = formatJsonRpcSuccess(rpcRequest.id, result);
      return [...notifications, response].map((item) => JSON.stringify(item));
    } catch (error) {
      const info = describeConnectionError(error);
      const response = formatJsonRpcError(rpcRequest.id, info.status, info.message, {
        reason: info.code,
        ...(info.issues !== undefined ? { issues: info.issues } : {}),
      });
      return [JSON.stringify(response)];
    }
  }
}
