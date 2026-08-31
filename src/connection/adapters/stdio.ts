import {
  formatJsonRpcError,
  formatJsonRpcNotifications,
  formatJsonRpcSuccess,
} from "../event-formatter.js";
import { parseJsonRpcRequest } from "../json-rpc.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { describeConnectionError } from "../errors.js";
import { SessionGateway } from "../session-gateway.js";

export class StdioAdapter {
  readonly transportKind: TransportKind = "stdio";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: string): Promise<string> {
    const rpcRequest = parseJsonRpcRequest(JSON.parse(input));

    try {
      const envelope = parseAgentRequestEnvelope(rpcRequest.params);
      const result = await this.gateway.handleRequest(envelope, "stdio");
      const notifications = formatJsonRpcNotifications(result.events);
      const response = formatJsonRpcSuccess(rpcRequest.id, result);
      return [...notifications, response].map((item) => JSON.stringify(item)).join("\n");
    } catch (error) {
      const info = describeConnectionError(error);
      const response = formatJsonRpcError(rpcRequest.id, info.status, info.message, {
        reason: info.code,
        ...(info.issues !== undefined ? { issues: info.issues } : {}),
      });
      return JSON.stringify(response);
    }
  }
}
