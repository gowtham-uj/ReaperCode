import { randomUUID } from "node:crypto";

import { formatHttpJsonResult, formatJsonRpcError, formatJsonRpcNotifications, formatJsonRpcSuccess, formatSseEvents } from "./event-formatter.js";
import { parseJsonRpcRequest, type JsonRpcRequest } from "./json-rpc.js";
import { AgentRequestEnvelopeSchema, parseAgentRequestEnvelope, type AgentRequestEnvelope, type TransportKind } from "./schemas.js";
import { ConnectionPolicyError, SessionNotFoundError } from "./errors.js";
import { SessionGateway } from "./session-gateway.js";

export interface AdaptiveConnectionInput {
  transport?: TransportKind | "auto";
  accept?: string;
  now?: Date;
}

export interface AdaptiveConnectionResponse {
  transport: TransportKind;
  contentType: "application/json" | "text/event-stream" | "application/x-ndjson";
  body: unknown;
}

export class AdaptiveConnectionLayer {
  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown, options: AdaptiveConnectionInput = {}): Promise<AdaptiveConnectionResponse> {
    let rpcRequest: JsonRpcRequest | undefined;
    try {
      const normalizedInput = typeof input === "string" ? JSON.parse(input) : input;
      rpcRequest = isJsonRpcLike(normalizedInput) ? parseJsonRpcRequest(normalizedInput) : undefined;
      const envelope = normalizeEnvelope(rpcRequest ? rpcRequest.params : normalizedInput, options.now ?? new Date());
      const transport = resolveTransport(options, envelope, Boolean(rpcRequest));
      const result = await this.gateway.handleRequest(envelope, transport);

      if (transport === "http_sse") {
        return { transport, contentType: "text/event-stream", body: formatSseEvents(result.events) };
      }

      if (transport === "stdio" || transport === "websocket" || rpcRequest) {
        const id = rpcRequest?.id ?? envelope.request_id;
        const messages = [...formatJsonRpcNotifications(result.events), formatJsonRpcSuccess(id, result)].map((item) => JSON.stringify(item));
        return {
          transport,
          contentType: transport === "stdio" ? "application/x-ndjson" : "application/json",
          body: transport === "stdio" ? messages.join("\n") : messages,
        };
      }

      return { transport, contentType: "application/json", body: formatHttpJsonResult(result) };
    } catch (error) {
      return formatAdaptiveError(error, resolveTransport(options, undefined, Boolean(rpcRequest)), rpcRequest);
    }
  }
}

function normalizeEnvelope(input: unknown, now: Date): AgentRequestEnvelope {
  const parsed = AgentRequestEnvelopeSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  if (input && typeof input === "object" && typeof (input as { prompt?: unknown }).prompt === "string") {
    const id = randomUUID();
    return {
      connection_id: `adaptive-${id}`,
      session_id: `session-${id}`,
      turn_id: `turn-${id}`,
      request_id: `request-${id}`,
      message_type: "user_prompt",
      timestamp: now.toISOString(),
      trace_id: `trace-${id}`,
      payload: { prompt: (input as { prompt: string }).prompt },
      metadata: {},
    };
  }

  return parseAgentRequestEnvelope(input);
}

function resolveTransport(
  options: AdaptiveConnectionInput,
  envelope?: AgentRequestEnvelope,
  isJsonRpc = false,
): TransportKind {
  if (options.transport && options.transport !== "auto") {
    return options.transport;
  }

  const metadataTransport = envelope?.metadata.transport;
  if (
    metadataTransport === "stdio" ||
    metadataTransport === "http_json" ||
    metadataTransport === "http_sse" ||
    metadataTransport === "websocket" ||
    metadataTransport === "webhook"
  ) {
    return metadataTransport;
  }

  const accept = options.accept?.toLowerCase() ?? "";
  if (accept.includes("text/event-stream")) {
    return "http_sse";
  }
  if (isJsonRpc) {
    return "stdio";
  }
  return "http_json";
}

function isJsonRpcLike(input: unknown): boolean {
  return Boolean(input && typeof input === "object" && (input as { jsonrpc?: unknown }).jsonrpc === "2.0");
}

function formatAdaptiveError(
  error: unknown,
  transport: TransportKind,
  rpcRequest: JsonRpcRequest | undefined,
): AdaptiveConnectionResponse {
  const code = error instanceof ConnectionPolicyError ? 403 : error instanceof SessionNotFoundError ? 404 : 500;
  const message = error instanceof Error ? error.message : "Unknown adaptive connection failure";

  if (transport === "http_sse") {
    return {
      transport,
      contentType: "text/event-stream",
      body: `event: error\ndata: ${JSON.stringify({ code, message })}\n\nevent: done\ndata: {}\n\n`,
    };
  }

  if (transport === "stdio" || transport === "websocket" || rpcRequest) {
    return {
      transport,
      contentType: transport === "stdio" ? "application/x-ndjson" : "application/json",
      body: JSON.stringify(formatJsonRpcError(rpcRequest?.id ?? "adaptive-error", code, message)),
    };
  }

  return {
    transport,
    contentType: "application/json",
    body: {
      status: "error",
      error: { code, message },
      events: [],
    },
  };
}
