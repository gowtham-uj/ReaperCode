import { formatHttpJsonResult } from "../event-formatter.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { SessionGateway } from "../session-gateway.js";

export class HttpJsonAdapter {
  readonly transportKind: TransportKind = "http_json";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown) {
    const envelope = parseAgentRequestEnvelope(input);
    const result = await this.gateway.handleRequest(envelope, "http_json");
    return formatHttpJsonResult(result);
  }
}
