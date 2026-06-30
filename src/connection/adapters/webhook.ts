import { formatHttpJsonResult } from "../event-formatter.js";
import { parseAgentRequestEnvelope, type TransportKind } from "../schemas.js";
import { SessionGateway } from "../session-gateway.js";

export class WebhookAdapter {
  readonly transportKind: TransportKind = "webhook";

  constructor(private readonly gateway: SessionGateway) {}

  async handle(input: unknown) {
    const envelope = parseAgentRequestEnvelope(input);
    const result = await this.gateway.handleRequest(envelope, "webhook");

    return {
      accepted: true,
      callback_target: envelope.metadata.callback_url ?? null,
      result: formatHttpJsonResult(result),
    };
  }
}
