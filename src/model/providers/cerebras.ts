import type { GenerateRequest, GenerateResult, ResolvedModelProfile, StreamEvent, TokenUsage } from "../types.js";
import type { ProviderModelClient } from "../gateway.js";
import { extractUsage, OpenAIChatResponseSchema, parseToolArguments } from "./response.js";

/** Cerebras native OpenAI-compatible API via https://api.cerebras.ai/v1. */
export class CerebrasClient implements ProviderModelClient {
  private readonly baseUrl = "https://api.cerebras.ai/v1";

  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : process.env.CEREBRAS_PROVIDER_KEY;
    if (!apiKey) throw new Error(`${profile.apiKeyEnv ?? "CEREBRAS_PROVIDER_KEY"} is required for Cerebras provider`);

    const body = {
      model: profile.model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: request.temperature ?? profile.defaultParams?.temperature ?? 0,
      max_completion_tokens: request.maxTokens ?? profile.defaultParams?.maxTokens ?? 4096,
      tools: request.tools?.length ? request.tools : undefined,
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      // Cerebras docs: json_object is not compatible with streaming.
      stream: false,
    };

    const response = await this.fetchWithRetries(apiKey, body, profile);
    const json = OpenAIChatResponseSchema.parse(await response.json());
    const choice = json.choices[0];
    const message = choice?.message;
    const reasoning = message?.reasoning ?? message?.reasoning_content ?? "";
    const toolCalls = Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name ?? tc.name ?? "",
          input: parseToolArguments(tc.function?.arguments ?? tc.input),
        }))
      : undefined;

    const usage = extractUsage(json);

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: "cerebras",
      model: json.model ?? profile.model,
      content: message?.content ?? "",
      ...(typeof reasoning === "string" && reasoning ? { reasoningContent: reasoning } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(usage ? { usage: usage as TokenUsage } : {}),
      raw: json,
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const result = await this.generate(request, profile);
    yield { type: "message_start", data: { provider: "cerebras", model: result.model } };
    if (result.reasoningContent) yield { type: "reasoning_delta", content: result.reasoningContent };
    if (result.content) yield { type: "message_delta", content: result.content };
    yield {
      type: "message_end",
      data: {
        finishReason: result.finishReason,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }

  async embed(): Promise<any> {
    throw new Error("Embeddings not supported via Cerebras provider");
  }

  private async fetchWithRetries(apiKey: string, body: unknown, profile: ResolvedModelProfile): Promise<Response> {
    const maxRetries = profile.maxRetries ?? 2;
    const maxRateLimitRetries = Number(process.env.CEREBRAS_RATE_LIMIT_MAX_RETRIES ?? 12);
    let lastError: unknown;
    for (let attempt = 0; attempt <= Math.max(maxRetries, maxRateLimitRetries); attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          ...(profile.timeoutMs ? { signal: AbortSignal.timeout(profile.timeoutMs) } : {}),
        });
        if (response.ok) return response;
        const text = await response.text().catch(() => "");
        lastError = new Error(`Cerebras request failed: HTTP ${response.status} - ${text.slice(0, 500)}`);
        const retryLimit = response.status === 429 ? maxRateLimitRetries : maxRetries;
        if (!isRetryableStatus(response.status) || attempt >= retryLimit) break;
        await wait(responseBackoffMs(attempt, Date.now() - startedAt, response.headers.get("retry-after"), response.status));
        continue;
      } catch (error) {
        lastError = error;
        const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.message.includes("timed out"));
        if (isTimeout || attempt >= maxRetries) break;
      }
      await wait(responseBackoffMs(attempt, Date.now() - startedAt));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function responseBackoffMs(attempt: number, durationMs: number, retryAfter: string | null = null, status?: number): number {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (retryAfterMs !== undefined) return Math.min(60_000, Math.max(1_000, retryAfterMs));
  const cap = status === 429 ? 30_000 : 4_000;
  const base = status === 429 ? 2_000 : 500;
  const jitter = Math.floor(Math.random() * 750);
  return Math.max(250, Math.min(cap, base * Math.pow(2, attempt) + jitter - Math.min(durationMs, 250)));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
