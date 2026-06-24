import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ResolvedModelProfile,
  StreamEvent,
  TokenUsage,
} from "../types.js";
import type { ProviderModelClient } from "../gateway.js";
import { mapGenerateRequestToLiteLLM, mapStreamRequestToLiteLLM } from "./parameter-mapper.js";
import { resolveProviderBaseUrl, resolveProviderDefaults, resolveProviderModelName, usesAzureOpenAiV1 } from "./provider-registry.js";
import { normalizeLiteLLMStream } from "./stream-normalizer.js";
import { extractUsage, OpenAIChatResponseSchema, OpenAIEmbeddingsResponseSchema, parseToolArguments } from "./response.js";

export interface LiteLLMGatewayOptions {
  fetchImpl?: typeof fetch;
  /**
   * Optional undici `Dispatcher` for per-family connection pool
   * tuning. Phase 2.4 seam — when omitted, fetch uses Node's
   * global undici agent which already pools per origin.
   */
  dispatcher?: unknown;
  onAttempt?: (event: LiteLLMAttemptEvent) => void | Promise<void>;
}

export interface LiteLLMAttemptEvent {
  operation: string;
  provider: string;
  model: string;
  role: string;
  profileName: string;
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  status?: number;
  ok: boolean;
  error?: string;
  retrying: boolean;
}

export class LiteLLMProviderClient implements ProviderModelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher: unknown | undefined;
  /**
   * Cached UTF-8 decoder for the SSE hot path. Constructing a
   * `TextDecoder` per turn costs ~1µs in V8 plus a finalizer; on
   * multi-turn sessions we keep one per client instance so each
   * streaming response reuses it.
   */
  private readonly sseDecoder: TextDecoder;

  constructor(private readonly options: LiteLLMGatewayOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dispatcher = options.dispatcher;
    this.sseDecoder = new TextDecoder();
  }

  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const HARD_TIMEOUT_MS = profile.timeoutMs ?? 300_000;
    const profileMaxTokens = Math.min(
      profile.defaultParams?.maxTokens ?? profile.capabilities.maxOutputTokens ?? 32768,
      profile.capabilities.maxOutputTokens ?? 32768,
    );
    const maxTokens = Math.min(
      request.maxTokens ?? profileMaxTokens,
      profileMaxTokens,
    );
    // Use streaming internally to avoid loading the entire response body into memory.
    // The original used response.text() which caused OOM crashes with reasoning models
    // that produce 8K-32K tokens of reasoning_content.
    const body = mapGenerateRequestToLiteLLM({ ...request, maxTokens }, profile);
    if (shouldUseBufferedGenerate(profile, request)) {
      const response = await this.fetchWithRetries(
        (signal) =>
          this.fetchImpl(this.resolveUrl(profile, "/chat/completions"), {
            method: "POST",
            headers: this.buildHeaders(profile),
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
            ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
          }),
        profile,
        "generate",
      );

      if (!response.ok) {
        throw await this.providerHttpError("generate", response, profile);
      }

      return await this.collectBufferedResponse(response, request, profile);
    }

    const response = await this.fetchWithRetries(
      (signal) =>
        this.fetchImpl(this.resolveUrl(profile, "/chat/completions"), {
          method: "POST",
          headers: this.buildHeaders(profile),
          body: JSON.stringify({ ...body, stream: true }),
          ...(signal ? { signal } : {}),
          ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
        }),
      profile,
      "generate",
    );

    if (!response.ok) {
      throw await this.providerHttpError("generate", response, profile);
    }

    return await this.collectStreamResponse(response, request, profile, HARD_TIMEOUT_MS);
  }

  private async collectBufferedResponse(
    response: Response,
    request: GenerateRequest,
    profile: ResolvedModelProfile,
  ): Promise<GenerateResult> {
    const parsed = OpenAIChatResponseSchema.parse(await response.json());
    const choice = parsed.choices[0];
    const msg = choice?.message;
    const toolCalls = msg?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name ?? "",
      input: parseToolArguments(tc.function?.arguments ?? tc.input),
    }));
    const usage = extractUsage(parsed);

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model: parsed.model ?? profile.model,
      content: msg?.content ?? "",
      ...(msg?.reasoning_content ? { reasoningContent: msg.reasoning_content.slice(0, 8192) } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(usage ? { usage: usage as TokenUsage } : {}),
      raw: parsed,
    };
  }

  private async collectStreamResponse(
    response: Response,
    request: GenerateRequest,
    profile: ResolvedModelProfile,
    timeoutMs: number,
  ): Promise<GenerateResult> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = this.sseDecoder;
    let content = "";
    let reasoningContent = "";
    let finishReason: string | undefined;
    let model = profile.model;
    let usageEnvelope: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
    const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();

    let buf = "";
    const deadline = Date.now() + timeoutMs;
    const idleTimeoutMs = resolveStreamIdleTimeoutMs(timeoutMs);
    try {
      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`LiteLLM stream timed out after ${timeoutMs}ms`);
        }
        const { done, value } = await readStreamChunkWithTimeout(reader, remainingMs, idleTimeoutMs);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (delta?.content) content += delta.content;
            if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (parsed.model) model = parsed.model;
            // Some LiteLLM routes (and most upstream providers behind
            // it) emit a final chunk with `usage` set and no choices;
            // capture it so we can surface token accounting on the
            // resulting GenerateResult.
            if (parsed.usage && typeof parsed.usage === "object") {
              usageEnvelope = parsed.usage;
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulators.has(idx)) {
                  toolCallAccumulators.set(idx, { id: tc.id ?? "", name: "", args: "" });
                }
                const acc = toolCallAccumulators.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }
          } catch {
            // Skip unparseable SSE chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...toolCallAccumulators.values()]
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
      }));

    const usage = usageEnvelope ? extractUsage({ usage: usageEnvelope }) : undefined;

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model,
      content,
      ...(reasoningContent ? { reasoningContent: reasoningContent.slice(0, 8192) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage: usage as TokenUsage } : {}),
      raw: { model, finishReason, ...(usageEnvelope ? { usage: usageEnvelope } : {}) },
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const response = await this.fetchWithRetries(
      (signal) =>
        this.fetchImpl(this.resolveUrl(profile, "/chat/completions"), {
          method: "POST",
          headers: this.buildHeaders(profile),
          body: JSON.stringify(mapStreamRequestToLiteLLM(request, profile)),
          ...(signal ? { signal } : {}),
          ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
        }),
      profile,
      "stream",
    );

    if (!response.ok) {
      throw await this.providerHttpError("stream", response, profile);
    }

    yield { type: "message_start", data: { provider: profile.provider, model: profile.model } };
    for await (const event of normalizeLiteLLMStream(response)) {
      yield event;
    }
  }

  async embed(request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult> {
    const response = await this.fetchWithRetries(
      (signal) =>
        this.fetchImpl(this.resolveUrl(profile, "/embeddings"), {
          method: "POST",
          headers: this.buildHeaders(profile),
          body: JSON.stringify({
            model: resolveProviderModelName(profile),
            input: request.input,
          }),
          ...(signal ? { signal } : {}),
          ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
        }),
      profile,
      "embed",
    );

    if (!response.ok) {
      throw await this.providerHttpError("embedding", response, profile);
    }

    const parsed = OpenAIEmbeddingsResponseSchema.parse(await response.json());

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model: parsed.model ?? profile.model,
      vectors: parsed.data.map((item) => item.embedding ?? []),
      raw: parsed,
    };
  }

  private resolveUrl(profile: ResolvedModelProfile, suffix: string): string {
    const base = resolveProviderBaseUrl(profile);
    const defaults = resolveProviderDefaults(profile);
    if (defaults.pathStyle === "azure-openai") {
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
      if (!apiVersion) {
        throw new Error("AZURE_OPENAI_API_VERSION is required for Azure OpenAI provider");
      }
      const normalizedBase = base.replace(/\/+$/, "");
      if (!normalizedBase) {
        throw new Error("AZURE_OPENAI_BASE_URL is required for Azure OpenAI provider");
      }
      const operation = suffix.replace(/^\//, "");
      if (usesAzureOpenAiV1(profile)) {
        return `${resolveAzureOpenAiV1Base(normalizedBase)}/${operation}`;
      }
      const deploymentBase = resolveAzureDeploymentBase(normalizedBase, resolveProviderModelName(profile));
      return `${deploymentBase}/${operation}?api-version=${encodeURIComponent(apiVersion)}`;
    }
    return `${base.replace(/\/$/, "")}${suffix}`;
  }

  private buildHeaders(profile: ResolvedModelProfile) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (profile.apiKeyEnv) {
      const value = process.env[profile.apiKeyEnv];
      if (!value) {
        throw new Error(`Environment variable '${profile.apiKeyEnv}' is required for provider '${profile.provider}'`);
      }

      const defaults = resolveProviderDefaults(profile);
      if (defaults.authHeader === "api-key") {
        headers[defaults.authHeader] = value;
      } else {
        headers[defaults.authHeader] = `Bearer ${value}`;
      }
    }

    return headers;
  }

  private async providerHttpError(operation: string, response: Response, profile: ResolvedModelProfile): Promise<Error> {
    const body = await response.text().catch(() => "");
    const bodyPreview = body.trim().slice(0, 600);
    return new Error(
      [
        `LiteLLM ${operation} request failed with status ${response.status}`,
        `provider=${profile.provider}`,
        `model=${profile.model}`,
        `profile=${profile.profileName}`,
        bodyPreview ? `body=${bodyPreview}` : undefined,
      ].filter(Boolean).join(" "),
    );
  }

  private async fetchWithRetries(
    operation: (signal: AbortSignal | undefined) => Promise<Response>,
    profile: ResolvedModelProfile,
    operationName: string,
  ): Promise<Response> {
    const maxRetries = profile.maxRetries ?? 3;
    const maxAttempts = maxRetries + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = profile.timeoutMs ? new AbortController() : undefined;
      const timeout = controller
        ? setTimeout(() => controller.abort(new Error(`Timed out after ${profile.timeoutMs}ms`)), profile.timeoutMs)
        : undefined;
      const startedAt = Date.now();
      try {
        const response = await operation(controller?.signal);
        const retrying = isRetryableStatus(response.status) && attempt < maxRetries;
        await this.reportAttempt({
          operation: operationName,
          profile,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          status: response.status,
          ok: response.ok,
          retrying,
        });
        if (!retrying) {
          return response;
        }
        lastError = new Error(`HTTP ${response.status}`);
        
        // Aggressive backoff for 429
        const waitMs = response.status === 429 
          ? 2000 * Math.pow(2, attempt) 
          : 500 * (attempt + 1);
        await wait(waitMs);
      } catch (error) {
        lastError = error;
        const isTimeout = error instanceof Error && (error.message.includes('Timed out') || error.name === 'TimeoutError' || error.message.includes('aborted'));
        // Don't retry on timeout - fail fast so agent can recover
        const retrying = !isTimeout && attempt < maxRetries;
        await this.reportAttempt({
          operation: operationName,
          profile,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          ok: false,
          error,
          retrying,
        });
        if (!retrying) {
          break;
        }
        await wait(1000 * Math.pow(2, attempt)); // Exponential backoff starting at 1s
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
    const detail = formatProviderError(lastError);
    throw new Error(
      `LiteLLM ${operationName} request failed after ${maxRetries + 1} attempt(s): ${detail}`,
    );
  }

  private async reportAttempt(input: {
    operation: string;
    profile: ResolvedModelProfile;
    attempt: number;
    maxAttempts: number;
    durationMs: number;
    ok: boolean;
    retrying: boolean;
    status?: number;
    error?: unknown;
  }): Promise<void> {
    if (!this.options.onAttempt) {
      return;
    }

    await this.options.onAttempt({
      operation: input.operation,
      provider: input.profile.provider,
      model: input.profile.model,
      role: input.profile.role,
      profileName: input.profile.profileName,
      attempt: input.attempt + 1,
      maxAttempts: input.maxAttempts,
      durationMs: input.durationMs,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ok: input.ok,
      ...(input.error !== undefined
        ? { error: input.error instanceof Error ? input.error.message : String(input.error) }
        : {}),
      retrying: input.retrying,
    });
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainingMs: number,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  const waitMs = Math.max(1, Math.min(remainingMs, idleTimeoutMs));
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new Error(`LiteLLM stream produced no data for ${waitMs}ms`));
        }, waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveStreamIdleTimeoutMs(totalTimeoutMs: number): number {
  const fromEnv = Number(process.env.REAPER_STREAM_IDLE_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(totalTimeoutMs, Math.floor(fromEnv));
  }
  return Math.min(totalTimeoutMs, 120_000);
}

function shouldUseBufferedGenerate(profile: ResolvedModelProfile, request: GenerateRequest): boolean {
  const provider = profile.provider.trim().toLowerCase();
  const model = profile.model.trim().toLowerCase();
  return request.responseFormat === "json" && (provider === "minimax" || model === "minimax-m3");
}

function resolveAzureOpenAiV1Base(base: string): string {
  if (/\/openai\/v1$/i.test(base)) return base;
  if (/\/openai$/i.test(base)) return `${base}/v1`;
  return `${base}/openai/v1`;
}

function resolveAzureDeploymentBase(base: string, deployment: string): string {
  if (/\/openai\/deployments\/[^/]+$/i.test(base)) return base;
  const resourceBase = base.replace(/\/openai(?:\/v1)?$/i, "");
  return `${resourceBase}/openai/deployments/${encodeURIComponent(deployment)}`;
}

function formatProviderError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : cause !== undefined ? String(cause) : "";
  return causeText ? `${error.name}: ${error.message}; cause=${causeText}` : `${error.name}: ${error.message}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
