/**
 * `ProviderModelClient` backed by the Vercel AI SDK.
 *
 * This is the transport every Models.dev-catalog provider routes through.
 * It resolves the catalog's npm/API identity for the selected model, builds
 * the SDK provider with per-call credentials, and normalizes the SDK's typed
 * stream back into Reaper's `StreamEvent` vocabulary so the agent loop, the
 * transcript, and the session log see exactly what they saw before.
 *
 * Credentials are per call. Nothing here mutates `process.env`, so two
 * threads on different providers never race each other's keys.
 */

import { embedMany, generateText, streamText } from "ai";

import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ResolvedModelProfile,
  StreamEvent,
} from "../types.js";
import type { ProviderModelClient } from "../gateway.js";
import { getModelsDevCatalog, type ModelsDevCatalogService } from "../provider/models-dev-catalog.js";
import { loadTransport, type TransportSdk } from "../provider/transports.js";
import { resolveTransport, type TransportContext } from "../provider/transport-options.js";
import { fromToolCalls, fromUsage, toModelMessages, toToolSet } from "./ai-sdk-mapper.js";
import { tryResolveApiKey } from "../credentials.js";

export interface AiSdkClientOptions {
  catalog?: ModelsDevCatalogService;
  /**
   * Non-secret per-provider auth metadata (resource name, account id, region).
   * Server-only: the browser never sees this and it never reaches a log.
   */
  metadataFor?: (providerId: string) => Record<string, string> | undefined;
  env?: Record<string, string | undefined>;
}

export class AiSdkProviderClient implements ProviderModelClient {
  private readonly catalog: ModelsDevCatalogService;
  private readonly options: AiSdkClientOptions;

  constructor(options: AiSdkClientOptions = {}) {
    this.options = options;
    this.catalog = options.catalog ?? getModelsDevCatalog();
  }

  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const model = await this.languageModel(profile);
    const result = await generateText({
      model: model as never,
      messages: toModelMessages(request),
      ...(request.system ? { system: request.system } : {}),
      ...toolArgs(request),
      ...samplingArgs(request, profile),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });

    const toolCalls = fromToolCalls(result.toolCalls ?? []);
    const usage = fromUsage(result.usage);
    return {
      role: request.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model: profile.model,
      content: result.text ?? "",
      ...(result.reasoningText ? { reasoningContent: result.reasoningText } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(usage ? { usage } : {}),
      raw: { finishReason: result.finishReason, usage: result.usage },
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const model = await this.languageModel(profile);
    const result = streamText({
      model: model as never,
      messages: toModelMessages(request),
      ...(request.system ? { system: request.system } : {}),
      ...toolArgs(request),
      ...samplingArgs(request, profile),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    });

    yield { type: "message_start", data: { provider: profile.provider, model: profile.model } };

    let finishReason: string | undefined;
    let usage: unknown;

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          if (part.text) yield { type: "message_delta", content: part.text };
          break;
        case "reasoning-delta":
          if (part.text) yield { type: "reasoning_delta", content: part.text };
          break;
        case "tool-call":
          yield {
            type: "tool_call",
            data: {
              id: part.toolCallId,
              name: part.toolName,
              args: part.input ?? {},
            },
          };
          break;
        case "finish":
          finishReason = part.finishReason;
          usage = part.totalUsage;
          break;
        case "error":
          throw normalizeError(part.error);
        case "abort":
          // The SDK reports cancellation as a stream part. Reaper's other
          // clients surface an aborted call by throwing, and the runtime
          // distinguishes cancellation by the error name.
          throw abortError();
        default:
          break;
      }
    }

    const normalizedUsage = fromUsage(usage);
    yield {
      type: "message_end",
      data: {
        ...(finishReason ? { finishReason } : {}),
        ...(normalizedUsage ? { usage: normalizedUsage } : {}),
      },
    };
  }

  async embed(request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult> {
    const { sdk } = await this.buildSdk(profile);
    if (typeof sdk.textEmbeddingModel !== "function") {
      throw new Error(`Provider "${profile.provider}" does not expose embeddings.`);
    }
    const values = Array.isArray(request.input) ? request.input : [request.input];
    const result = await embedMany({
      model: sdk.textEmbeddingModel(profile.model) as never,
      values,
    });
    return {
      role: request.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model: profile.model,
      vectors: result.embeddings,
      raw: { usage: result.usage },
    };
  }

  /** Build the concrete AI SDK language model for a profile. */
  private async languageModel(profile: ResolvedModelProfile): Promise<unknown> {
    const { sdk, selectModel } = await this.buildSdk(profile);
    return selectModel(sdk, profile.model);
  }

  private async buildSdk(profile: ResolvedModelProfile): Promise<{
    sdk: TransportSdk;
    selectModel: (sdk: TransportSdk, modelId: string) => unknown;
  }> {
    const context = this.transportContext(profile);
    const resolution = resolveTransport(context);
    /*
     * Coverage, checked where the catalog already is.
     *
     * A model the catalog advertises but this build has no package for must
     * fail with a sentence naming the package and the model the user picked,
     * not a bare module error from inside `loadTransport`. The verdict comes
     * from `isSelectionRunnable` rather than a second implementation so this
     * gate and the one the picker greys out models with cannot disagree.
     *
     * It runs here rather than in the engine because this is the only place
     * that needs the catalog at all: the engine would have had to read all
     * 4.5 MB of it to learn one npm string, on every turn's first model call,
     * and it would have paid that even for the legacy wire families that never
     * consult the catalog. Measured: ~1.1s added to first-token latency, which
     * is the whole budget the perf test allows.
     */
    // Imported lazily for the same reason it lives here at all: the auth
    // integration module graph is ~800ms to load, and a turn on any other
    // transport must not pay it.
    const { isSelectionRunnable } = await import("../provider/integration-registry.js");
    const verdict = isSelectionRunnable(profile.provider, profile.model, this.catalog);
    if (!verdict.runnable) {
      throw Object.assign(
        new Error(verdict.reason ?? `No transport is installed for '${resolution.npm}'`),
        { code: "ProviderNotReady", status: 400, provider: profile.provider, model: profile.model },
      );
    }
    const factory = await loadTransport(resolution.npm);
    return { sdk: factory(resolution.options), selectModel: resolution.selectModel };
  }

  private transportContext(profile: ResolvedModelProfile): TransportContext {
    const provider = this.catalog.provider(profile.provider);
    const model = this.catalog.model(profile.provider, profile.model);
    const npm = model?.provider?.npm ?? provider?.npm ?? "@ai-sdk/openai-compatible";
    const apiBase = profile.apiBase ?? model?.provider?.api ?? provider?.api;
    const apiKey = tryResolveApiKey(profile, provider?.env?.[0] ?? "");
    const metadata = this.options.metadataFor?.(profile.provider);
    return {
      providerId: profile.provider,
      modelId: profile.model,
      npm,
      ...(apiBase ? { apiBase } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(metadata ? { metadata } : {}),
      ...(provider?.env?.length ? { envVars: provider.env } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    };
  }
}

function toolArgs(request: GenerateRequest): Record<string, unknown> {
  const tools = toToolSet(request.tools);
  if (!tools) return {};
  // The agent loop executes tools itself, so the SDK must stop after the
  // model asks rather than resolving the call and looping internally.
  return { tools, stopWhen: () => true };
}

function samplingArgs(request: GenerateRequest, profile: ResolvedModelProfile): Record<string, unknown> {
  const temperature = request.temperature ?? profile.defaultParams?.temperature;
  const maxTokens = request.maxTokens ?? profile.defaultParams?.maxTokens;
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    ...(profile.maxRetries !== undefined ? { maxRetries: profile.maxRetries } : {}),
  };
}

function abortError(): Error {
  const error = new Error("The model call was aborted");
  error.name = "AbortError";
  return error;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "The provider stream failed");
}
