import type { AgentEventEnvelope } from "./schemas.js";
import type { JsonRpcId, JsonRpcNotification, JsonRpcResponse } from "./json-rpc-helpers.js";

export interface GatewayResponseShape {
  sessionId: string;
  requestId: string;
  status: "completed" | "cancelled" | "resumed" | "error";
  events: AgentEventEnvelope[];
  resumed: boolean;
}

export function formatHttpJsonResult(result: GatewayResponseShape) {
  return {
    session_id: result.sessionId,
    request_id: result.requestId,
    status: result.status,
    resumed: result.resumed,
    events: result.events,
  };
}

export function formatSseEvents(events: AgentEventEnvelope[]): string {
  return `${events
    .map((event) => `event: ${event.message_type}\ndata: ${JSON.stringify(event)}\n`)
    .join("\n")}\nevent: done\ndata: {}\n\n`;
}

export function formatJsonRpcNotifications(events: AgentEventEnvelope[]): JsonRpcNotification[] {
  return events.map((event) => ({
    jsonrpc: "2.0",
    method: "agent.event",
    params: event,
  }));
}

export function formatJsonRpcSuccess(id: JsonRpcId, result: GatewayResponseShape): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: formatHttpJsonResult(result),
  };
}

export function formatJsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}
