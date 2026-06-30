import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ResolvedModelProfile,
  StreamEvent,
} from "./types.js";
import type { ProviderModelClient } from "./gateway.js";
import { buildProvider } from "./provider/registry.js";
import type {
  ModelProvider,
  ProviderCallInput,
  ProviderCallResult,
  ProviderStreamEvent,
} from "./provider/types.js";

/**
 * Adapts the new catalog-based `ModelProvider` family to the legacy
 * `ProviderModelClient` contract so the existing `ConfiguredModelGateway`
 * can use the standardized provider catalog without a full migration.
 *
 * This is the runtime seam: the new provider catalog (`provider/catalog.ts`)
 * owns env resolution and SDK-family selection; this adapter translates
 * engine-shaped `GenerateRequest`s into family-shaped `ProviderCallInput`s
 * and back.
 */
export class CatalogProviderClient implements ProviderModelClient {
  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const provider = this.resolveProvider(profile);
    const result = await provider.generate(this.toCallInput(request, profile));
    return this.fromCallResult(result, request.role, profile);
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const provider = this.resolveProvider(profile);
    for await (const ev of provider.stream(this.toCallInput(request, profile))) {
      yield this.toStreamEvent(ev);
    }
  }

  async embed(_request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult> {
    throw new Error(`Catalog adapter: embed not yet implemented for '${profile.provider}'`);
  }

  async dispose(): Promise<void> {
    // Providers are recreated per call; no lifecycle here.
  }

  private resolveProvider(profile: ResolvedModelProfile): ModelProvider {
    return buildProvider({
      providerId: profile.provider as any,
      modelId: profile.model,
      role: profile.role as any,
    });
  }

  private toCallInput(request: GenerateRequest, profile: ResolvedModelProfile): ProviderCallInput {
    const systemMessages = [
      request.system,
      ...request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content),
    ].filter((value): value is string => Boolean(value));
    const system = systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined;
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: m.content }));
    const tools = (request.tools ?? []).map((t) => ({
      name: (t as any).name as string,
      description: (t as any).description as string,   // ProviderTool requires string; pass empty if missing
      inputSchema: ((t as any).inputSchema ?? (t as any).parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
    return {
      ...(system ? { system } : {}),
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : profile.defaultParams?.maxTokens !== undefined
          ? { maxTokens: profile.defaultParams.maxTokens }
          : {}),
    };
  }

  private fromCallResult(
    result: ProviderCallResult,
    role: string,
    profile: ResolvedModelProfile,
  ): GenerateResult {
    return {
      role: role as any,
      profileName: profile.profileName,
      provider: profile.provider,
      model: profile.model,
      content: result.content ?? "",
      ...(result.reasoningContent !== undefined ? { reasoningContent: result.reasoningContent } : {}),
      ...(result.toolCalls !== undefined && result.toolCalls.length > 0
        ? {
            toolCalls: result.toolCalls.map((tc) => ({
              id: tc.id ?? "",
              name: tc.name,
              input: tc.args,
            })),
          }
        : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      raw: result.raw ?? {},
    };
  }

  private toStreamEvent(ev: ProviderStreamEvent): StreamEvent {
    switch (ev.type) {
      case "message_start":
      case "message_end":
      case "error":
        return ev as StreamEvent;
      case "message_delta":
        return { type: "message_delta", content: ev.content ?? "" };
      case "tool_call": {
        const call = ev.call as { id?: string; name: string; args?: Record<string, unknown>; arguments?: string };
        const input = call.args ?? parseStreamToolArguments(call.arguments);
        return { type: "tool_call", data: { id: call.id ?? "", name: call.name, args: input } };
      }
      default:
        return { type: "message_delta", content: "" };
    }
  }
}

function parseStreamToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
