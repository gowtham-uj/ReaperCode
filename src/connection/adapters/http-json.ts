import { toBadRequestError } from "../errors.js";
import { formatHttpJsonResult } from "../event-formatter.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { SessionGateway } from "../session-gateway.js";

export class HttpJsonAdapter {
  readonly transportKind: TransportKind = "http_json";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown) {
    let envelope;
    try {
      envelope = parseAgentRequestEnvelope(input);
    } catch (error) {
      throw toBadRequestError(error);
    }
    const result = await this.gateway.handleRequest(envelope, "http_json");
    return formatHttpJsonResult(result);
  }
}
