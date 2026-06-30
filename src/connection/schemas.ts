import { z } from "zod";

export const TransportKindSchema = z.enum([
  "stdio",
  "http_json",
  "http_sse",
  "websocket",
  "webhook",
]);

export const MessageTypeSchema = z.enum([
  "user_prompt",
  "session_resume",
  "cancel_request",
  "abort_execution",
  "tool_result_callback",
  "assistant_delta",
  "assistant_message",
  "tool_call_started",
  "tool_call_completed",
  "verify_started",
  "verify_failed",
  "task_completed",
  "error",
]);

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const EnvelopeMetadataSchema = z.record(z.string(), z.unknown());
export const EnvelopePayloadSchema = z.record(z.string(), z.unknown());

export const BaseEnvelopeSchema = z
  .object({
    connection_id: z.string().min(1),
    session_id: z.string().min(1),
    turn_id: z.string().min(1),
    request_id: z.string().min(1),
    message_type: MessageTypeSchema,
    timestamp: IsoDateTimeSchema,
    trace_id: z.string().min(1),
    payload: EnvelopePayloadSchema,
    metadata: EnvelopeMetadataSchema.default({}),
  })
  .strict();

export const AgentRequestEnvelopeSchema = BaseEnvelopeSchema.extend({
  message_type: z.enum([
    "user_prompt",
    "session_resume",
    "cancel_request",
    "abort_execution",
    "tool_result_callback",
  ]),
});

export const AgentEventEnvelopeSchema = BaseEnvelopeSchema.extend({
  message_type: z.enum([
    "assistant_delta",
    "assistant_message",
    "tool_call_started",
    "tool_call_completed",
    "verify_started",
    "verify_failed",
    "task_completed",
    "error",
  ]),
});

export type TransportKind = z.infer<typeof TransportKindSchema>;
export type AgentRequestEnvelope = z.infer<typeof AgentRequestEnvelopeSchema>;
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>;

export function parseAgentRequestEnvelope(input: unknown): AgentRequestEnvelope {
  return AgentRequestEnvelopeSchema.parse(input);
}

export function parseAgentEventEnvelope(input: unknown): AgentEventEnvelope {
  return AgentEventEnvelopeSchema.parse(input);
}
