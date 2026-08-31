import { toBadRequestError } from "../errors.js";
import { formatHttpJsonResult } from "../event-formatter.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { SessionGateway } from "../session-gateway.js";

export class WebhookAdapter {
  readonly transportKind: TransportKind = "webhook";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown) {
    let envelope;
    try {
      envelope = parseAgentRequestEnvelope(input);
    } catch (error) {
      throw toBadRequestError(error);
    }
    const result = await this.gateway.handleRequest(envelope, "webhook");

    return {
      accepted: true,
      callback_target: envelope.metadata.callback_url ?? null,
      result: formatHttpJsonResult(result),
    };
  }
}
