import { formatSseEvents } from "../event-formatter.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { SessionGateway } from "../session-gateway.js";

export class HttpSseAdapter {
  readonly transportKind: TransportKind = "http_sse";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown): Promise<string> {
    const envelope = parseAgentRequestEnvelope(input);
    const result = await this.gateway.handleRequest(envelope, "http_sse");
    return formatSseEvents(result.events);
  }
}
