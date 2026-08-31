import { toBadRequestError } from "../errors.js";
import { formatSseEvents } from "../event-formatter.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { SessionGateway } from "../session-gateway.js";

export class HttpSseAdapter {
  readonly transportKind: TransportKind = "http_sse";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown): Promise<string> {
    let envelope;
    try {
      envelope = parseAgentRequestEnvelope(input);
    } catch (error) {
      throw toBadRequestError(error);
    }
    const result = await this.gateway.handleRequest(envelope, "http_sse");
    return formatSseEvents(result.events);
  }
}
