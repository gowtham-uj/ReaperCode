import type { GenerateRequest, GenerateResult, ResolvedModelProfile, StreamEvent, TokenUsage } from "../types.js";
import type { ProviderModelClient } from "../gateway.js";

export interface DeepSeekClientOptions {
  fetchImpl?: typeof fetch;
  /**
   * Optional undici `Dispatcher` for per-family connection pool
   * tuning. Phase 2.4 seam — when omitted, fetch uses Node's
   * global undici agent which already pools per origin.
   */
  dispatcher?: unknown;
}

type DeepSeekUsage = Record<string, unknown> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

/**
 * DeepSeek native provider — OpenAI-compatible API via api.deepseek.com.
 * Supports: deepseek-chat, deepseek-reasoner (R1), deepseek-v3.
 */
export class DeepSeekClient implements ProviderModelClient {
  private readonly baseUrl = "https://api.deepseek.com";
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher: unknown | undefined;
  /**
   * Cached UTF-8 decoder for the SSE hot path. Reused across every
   * streaming response within this client instance.
   */
  private readonly sseDecoder: TextDecoder;

  constructor(options: DeepSeekClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dispatcher = options.dispatcher;
    this.sseDecoder = new TextDecoder();
  }

  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for DeepSeek provider");

    const maxTokens = Math.min(
      request.maxTokens ?? profile.defaultParams?.maxTokens ?? 4096,
      8192
    );

    const body = {
      model: profile.model,
      messages: buildDeepSeekMessages(request),
      temperature: request.temperature ?? profile.defaultParams?.temperature ?? 0.7,
      max_tokens: maxTokens,
      tools: request.tools?.length ? request.tools : undefined,
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      ...(profile.model.startsWith("deepseek-v4")
        ? { thinking: { type: process.env.DEEPSEEK_THINKING === "1" ? "enabled" : "disabled" } }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    };

    const maxRetries = profile.maxRetries ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(profile.timeoutMs ?? 300_000),
          ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          if (res.status === 429 && attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(`DeepSeek request failed: HTTP ${res.status} — ${errText.slice(0, 300)}`);
        }

        return await this.collectStreamResponse(res, request, profile, profile.timeoutMs ?? 300_000);
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async collectStreamResponse(
    res: Response,
    request: GenerateRequest,
    profile: ResolvedModelProfile,
    timeoutMs: number,
  ): Promise<GenerateResult> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = this.sseDecoder;
    let content = "";
    let reasoningContent = "";
    let finishReason: string | undefined;
    let model = profile.model;
    let usage: DeepSeekUsage | undefined;
    const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();
    const deadline = Date.now() + timeoutMs;

    let buf = "";
    try {
      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`DeepSeek stream timed out after ${timeoutMs}ms`);
        }
        const { done, value } = await readStreamChunkWithTimeout(reader, remainingMs, timeoutMs);
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
            if (isUsageObject(parsed.usage)) usage = parsed.usage;

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
          } catch (error) {
            throw new Error(`DeepSeek stream returned unparseable SSE JSON chunk: ${error instanceof Error ? error.message : String(error)}`);
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
        input: (() => { try { return JSON.parse(tc.args); } catch { return tc.args; } })(),
      }));

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: "deepseek",
      model,
      content: content.slice(0, 16384),
      ...(reasoningContent ? { reasoningContent: reasoningContent.slice(0, 8192) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage: deepSeekUsageToTokenUsage(usage) } : {}),
      raw: {
        model,
        finishReason,
        promptCache: describeDeepSeekPromptCache(profile),
        ...(usage ? { usage } : {}),
      },
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");

    const body = {
      model: profile.model,
      messages: buildDeepSeekMessages(request),
      temperature: request.temperature ?? profile.defaultParams?.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? profile.defaultParams?.maxTokens ?? 4096,
      tools: request.tools?.length ? request.tools : undefined,
      ...(profile.model.startsWith("deepseek-v4")
        ? { thinking: { type: process.env.DEEPSEEK_THINKING === "1" ? "enabled" : "disabled" } }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    };

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(profile.timeoutMs ?? 300_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
    });

    if (!res.ok) {
      throw new Error(`DeepSeek stream request failed: HTTP ${res.status}`);
    }

    yield { type: "message_start", data: { provider: "deepseek", model: profile.model } };

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body from DeepSeek");

    const decoder = this.sseDecoder;
    let buf = "";
    let finishReason: string | undefined;
    let usage: DeepSeekUsage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              if (isUsageObject(parsed.usage)) usage = parsed.usage;
              if (delta?.reasoning_content) {
                yield { type: "reasoning_delta", content: delta.reasoning_content, data: parsed };
              }
              if (delta?.content) {
                yield { type: "message_delta", content: delta.content, data: parsed };
              }
            } catch {}
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: "message_end",
      data: {
        finishReason: finishReason ?? "stop",
        promptCache: describeDeepSeekPromptCache(profile),
        ...(usage ? { usage } : {}),
      },
    };
  }

  async embed(): Promise<any> {
    throw new Error("Embeddings not supported via DeepSeek API");
  }
}

function buildDeepSeekMessages(request: GenerateRequest): Array<{ role: string; content: string }> {
  return [
    ...(request.system?.trim() ? [{ role: "system", content: request.system }] : []),
    ...request.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
}

function describeDeepSeekPromptCache(profile: ResolvedModelProfile) {
  return {
    enabled: profile.defaultParams?.promptCache?.enabled ?? true,
    mode: "provider_automatic_prefix_cache",
    minContentChars: profile.defaultParams?.promptCache?.minContentChars ?? 256,
  };
}

function isUsageObject(value: unknown): value is DeepSeekUsage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepSeekUsageToTokenUsage(u: DeepSeekUsage): TokenUsage {
  const out: TokenUsage = {
    inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
  };
  if (typeof u.prompt_cache_hit_tokens === "number") out.cacheReadTokens = u.prompt_cache_hit_tokens;
  if (typeof u.prompt_cache_miss_tokens === "number") {
    // DeepSeek doesn't split cache-miss vs cache-write; treat the
    // miss portion as the "non-cached input" — track it as input
    // tokens, not cache-write (which would double-count against
    // inputTokens). This keeps the input total honest.
    out.inputTokens += u.prompt_cache_miss_tokens;
  }
  return out;
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainingMs: number,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DeepSeek stream timed out after ${timeoutMs}ms`)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
