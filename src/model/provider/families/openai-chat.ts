/**
 * model/provider/families/openai-chat.ts — the OpenAI chat
 * completions family. Wraps the existing `LiteLLMProviderClient`
 * (which already implements `ProviderModelClient` for the
 * OpenAI-shaped wire).
 *
 * Vendors that speak the OpenAI wire today:
 *   - OpenAI        (api.openai.com)
 *   - MiniMax       (api.minimax.io)
 *   - DeepSeek      (api.deepseek.com — but DeepSeekClient is the
 *                    native impl; this family is the fallback for
 *                    vendors that don't ship their own client)
 *   - Cerebras      (api.cerebras.ai)
 *   - OpenRouter    (openrouter.ai)
 *   - DeepInfra     (api.deepinfra.com)
 *   - OpenAI-compatible proxies (vLLM, LiteLLM proxy, etc.)
 *
 * The LiteLLM client is named after the LiteLLM proxy, but the
 * actual transport is plain OpenAI chat completions — same shape
 * all 30+ OpenAI-compatible vendors speak. We pass through.
 *
 * Adding a NEW provider that speaks the OpenAI wire = add an
 * entry to `catalog.ts`. No code change here.
 */

import { LiteLLMProviderClient } from "../../providers/litellm-gateway.js";
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

function toLegacyRequest(
  input: ProviderCallInput,
  model: ResolvedModel,
): { role: ModelRole; payload: Parameters<ProviderModelClient["generate"]>[0] } {
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  for (const m of input.messages) {
    messages.push({ role: m.role, content: m.content });
  }
  const tools = (input.tools ?? []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputSchema,
    },
  }));
  return {
    role: model.role,
    payload: {
      role: model.role,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    },
  };
}

function toLegacyProfile(
  descriptor: ProviderDescriptor,
  model: ResolvedModel,
): ResolvedModelProfile {
  return {
    profileName: model.role,
    role: model.role,
    provider: descriptor.id,
    model: model.modelId,
    apiBase: descriptor.baseUrl,
    apiKeyEnv: descriptor.envVar,
    capabilities: descriptor.capabilities,
  };
}

class OpenAIChatProvider implements ModelProvider {
  readonly providerId: string;
  readonly sdkFamily = "openai-chat" as const;
  readonly modelId: string;
  readonly capabilities: ResolvedModel["capabilities"];

  private readonly client: ProviderModelClient;
  private readonly profile: ResolvedModelProfile;
  private readonly apiBase: string;

  constructor(args: {
    descriptor: ProviderDescriptor;
    resolved: ResolvedProvider;
    model: ResolvedModel;
  }) {
    this.providerId = args.descriptor.id;
    this.modelId = args.model.modelId;
    this.capabilities = args.descriptor.capabilities;
    this.apiBase = args.descriptor.baseUrl.replace(/\/$/, "");
    this.profile = toLegacyProfile(args.descriptor, args.model);
    // The LiteLLM client reads `process.env[profile.apiKeyEnv]`.
    // The registry already validated the key exists; we just need
    // to make sure the env var is set for this process.
    process.env[args.descriptor.envVar] = args.resolved.apiKey;
    this.client = new LiteLLMProviderClient();
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
        ? {
            toolCalls: (result.toolCalls as Array<{
              id?: string;
              name?: string;
              function?: { name?: string; arguments?: string };
              input?: unknown;
            }>).map((tc) => {
              // Accept both the OpenAI wire shape (`function.name`/`function.arguments`)
              // and the normalized shape produced by Reaper's LiteLLM client
              // (`name`/`input`). Provider catalogs built on top of this family
              // silently dropped native tool calls before this fix.
              const name = tc.name ?? tc.function?.name ?? "";
              const rawArgs = tc.input !== undefined
                ? tc.input
                : parseArgs(tc.function?.arguments);
              const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
                ? (rawArgs as Record<string, unknown>)
                : {};
              return { id: tc.id ?? "", name, args };
            }),
          }
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
    const events = this.client.stream({ ...payload, role }, this.profile);
    for await (const ev of events) {
      yield mapStreamEvent(ev, this.providerId, this.modelId);
    }
  }

  async dispose(): Promise<void> {
    await this.client.dispose?.();
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string | undefined): ProviderCallResult["finishReason"] {
  switch (reason) {
    case "stop":
    case "completed":
      return "stop";
    case "tool_calls":
    case "tool_use":
      return "tool_use";
    case "length":
    case "max_tokens":
      return "length";
    case "error":
      return "error";
    default:
      return "stop";
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

export const openaiChatFamily: SdkFamilyAdapter = {
  id: "openai-chat",
  buildProvider: (args) => new OpenAIChatProvider(args),
};
