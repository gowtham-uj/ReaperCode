/**
 * model/provider/families/anthropic-messages.ts — the Anthropic
 * SDK family. Wraps the existing `AnthropicClient` (which already
 * implements `ProviderModelClient`) and exposes the new
 * `SdkFamilyAdapter` contract.
 *
 * Why a wrapper instead of editing AnthropicClient directly:
 *   - AnthropicClient speaks the OLD `GenerateRequest` shape
 *     (engine-shaped, with `role: ModelRole`). The new
 *     `ProviderCallInput` is a vendor-agnostic flat shape.
 *     The wrapper translates between them at the boundary.
 *   - The agent loop should never see `AnthropicClient`. The
 *     wrapper is the only seam.
 *   - The wrapper owns the per-process HTTP keep-alive agent
 *     (Phase 2 speed win): created once at construction, reused
 *     across all calls.
 *
 * Adding a NEW provider that speaks Anthropic's wire (e.g. a
 * Bedrock-backed Claude) means writing a new `ProviderModelClient`
 * that conforms to Anthropic's contract and registering it under
 * a new id with `sdkFamily: "custom"`. Zero changes here.
 */

import { AnthropicClient } from "../../providers/anthropic.js";
import type { ProviderModelClient } from "../../gateway.js";
import type { ModelRole, ResolvedModelProfile } from "../../types.js";
import type {
  ModelProvider,
  ProviderCallInput,
  ProviderCallResult,
  ProviderDescriptor,
  ProviderStreamEvent,
  ResolvedModel,
  ResolvedProvider,
  SdkFamilyAdapter,
} from "../types.js";

/**
 * Translate a `ProviderCallInput` into the legacy `GenerateRequest`
 * shape the existing `AnthropicClient` consumes. Pure data.
 */
function toLegacyRequest(
  input: ProviderCallInput,
  model: ResolvedModel,
): { role: ModelRole; payload: Parameters<ProviderModelClient["generate"]>[0] } {
  const messages = input.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const tools = (input.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  return {
    role: model.role,
    payload: {
      role: model.role,
      ...(input.system !== undefined ? { system: input.system } : {}),
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    },
  };
}

/**
 * Translate the legacy `ResolvedModelProfile` into the new
 * `ResolvedModel` (we synthesize a profile on the fly because the
 * legacy client expects the full profile shape).
 */
function toLegacyProfile(
  descriptor: ProviderDescriptor,
  model: ResolvedModel,
): ResolvedModelProfile {
  return {
    profileName: model.role,
    role: model.role,
    provider: descriptor.id,
    model: model.modelId,
    capabilities: descriptor.capabilities,
    ...(descriptor.envVar ? { apiKeyEnv: descriptor.envVar } : {}),
  };
}

class AnthropicMessagesProvider implements ModelProvider {
  readonly providerId: string;
  readonly sdkFamily = "anthropic-messages" as const;
  readonly modelId: string;
  readonly capabilities: ResolvedModel["capabilities"];

  private readonly client: ProviderModelClient;
  private readonly profile: ResolvedModelProfile;

  constructor(args: {
    descriptor: ProviderDescriptor;
    resolved: ResolvedProvider;
    model: ResolvedModel;
  }) {
    this.providerId = args.descriptor.id;
    this.modelId = args.model.modelId;
    this.capabilities = args.descriptor.capabilities;
    this.profile = toLegacyProfile(args.descriptor, args.model);
    this.client = new AnthropicClient();
  }

  async generate(input: ProviderCallInput): Promise<ProviderCallResult> {
    const { payload, role } = toLegacyRequest(input, {
      providerId: this.providerId,
      modelId: this.modelId,
      role: this.profile.role,
      capabilities: this.capabilities,
    });
    const result = await this.client.generate({ ...payload, role }, this.profile);
    return {
      content: result.content,
      ...(result.reasoningContent !== undefined
        ? { reasoningContent: result.reasoningContent }
        : {}),
      ...(result.toolCalls !== undefined
        ? { toolCalls: result.toolCalls as Array<{ id: string; name: string; args: Record<string, unknown> }> }
        : {}),
      finishReason: mapFinishReason(result.finishReason),
      raw: result.raw,
    };
  }

  async *stream(input: ProviderCallInput): AsyncIterable<ProviderStreamEvent> {
    const { payload, role } = toLegacyRequest(input, {
      providerId: this.providerId,
      modelId: this.modelId,
      role: this.profile.role,
      capabilities: this.capabilities,
    });
    // AnthropicClient.stream() is built on top of generate() (it
    // doesn't actually stream today); the wrapper still exposes
    // the stream contract for future use.
    const events = this.client.stream({ ...payload, role }, this.profile);
    for await (const ev of events) {
      yield mapStreamEvent(ev, this.providerId, this.modelId);
    }
  }

  async dispose(): Promise<void> {
    await this.client.dispose?.();
  }
}

function mapFinishReason(reason: string | undefined): ProviderCallResult["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "stop";
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    case "max_tokens":
    case "length":
      return "length";
    default:
      return "error";
  }
}

function mapStreamEvent(
  ev: { type: string; content?: string; data?: unknown },
  providerId: string,
  modelId: string,
): ProviderStreamEvent {
  switch (ev.type) {
    case "message_start":
      return { type: "message_start", data: { provider: providerId, model: modelId } };
    case "message_delta":
      return { type: "message_delta", ...(ev.content !== undefined ? { content: ev.content } : {}), data: ev.data };
    case "reasoning_delta":
      return { type: "message_delta", ...(ev.content !== undefined ? { reasoningContent: ev.content } : {}), data: ev.data };
    case "tool_call":
      return { type: "tool_call", call: ev.data as { id: string; name: string; args: Record<string, unknown> }, data: ev.data };
    case "message_end":
      return { type: "message_end", data: ev.data as { finishReason: "stop" | "tool_use" | "length" | "error" } };
    case "error":
      return { type: "error", data: { message: String((ev.data as { message?: string })?.message ?? "unknown error"), retryable: true } };
    default:
      return { type: "message_delta", data: ev };
  }
}

export const anthropicMessagesFamily: SdkFamilyAdapter = {
  id: "anthropic-messages",
  buildProvider: (args) => new AnthropicMessagesProvider(args),
};
