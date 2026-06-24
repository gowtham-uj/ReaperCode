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
import { AnthropicMessagesResponseSchema } from "./response.js";

export interface AnthropicClientOptions {
  fetchImpl?: typeof fetch;
  /**
   * Optional undici `Dispatcher` passed through to fetch as the
   * `dispatcher` field. Lets callers tune connection pool sizing,
   * idle timeouts, and pipelining per provider. When omitted, fetch
   * uses Node's global undici agent which already keeps idle
   * connections open per origin (default 15 sockets, 5s idle
   * timeout). Phase 2.4: this is the seam for per-family tuning.
   */
  dispatcher?: unknown;
}

/** Official Anthropic Messages API client. */
export class AnthropicClient implements ProviderModelClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher: unknown | undefined;

  constructor(options: AnthropicClientOptions = {}) {
    this.baseUrl = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dispatcher = options.dispatcher;
  }

  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.buildHeaders(profile),
      body: JSON.stringify(this.buildBody(request, profile, false)),
      ...(profile.timeoutMs ? { signal: AbortSignal.timeout(profile.timeoutMs) } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Anthropic request failed: HTTP ${response.status} - ${errText.slice(0, 500)}`);
    }

    const json = AnthropicMessagesResponseSchema.parse(await response.json());
    const toolCalls = json.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));
    const content = json.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    const usage = extractAnthropicUsage(json);

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: "anthropic",
      model: json.model ?? profile.model,
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(json.stop_reason ? { finishReason: json.stop_reason } : {}),
      ...(usage ? { usage } : {}),
      raw: json,
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const result = await this.generate(request, profile);
    yield { type: "message_start", data: { provider: "anthropic", model: result.model } };
    if (result.content) yield { type: "message_delta", content: result.content };
    if (result.toolCalls) yield { type: "tool_call", data: result.toolCalls };
    yield {
      type: "message_end",
      data: {
        finishReason: result.finishReason,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }

  async embed(_request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult> {
    throw new Error(`Embeddings are not supported by Anthropic profile '${profile.profileName}'`);
  }

  private buildBody(request: GenerateRequest, profile: ResolvedModelProfile, stream: boolean) {
    const systemMessages = [
      request.system,
      ...request.messages.filter((message) => message.role === "system").map((message) => message.content),
      request.responseFormat === "json" ? "Return only a valid JSON object. No markdown fences or explanatory text." : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      model: profile.model,
      max_tokens: request.maxTokens ?? profile.defaultParams?.maxTokens ?? 4096,
      messages: coalesceMessages(request.messages.filter((message) => message.role !== "system")),
      ...(systemMessages.length > 0 ? { system: systemMessages.join("\n\n") } : {}),
      ...(request.temperature !== undefined || profile.defaultParams?.temperature !== undefined
        ? { temperature: request.temperature ?? profile.defaultParams?.temperature }
        : {}),
      ...(profile.defaultParams?.topP !== undefined ? { top_p: profile.defaultParams.topP } : {}),
      ...(profile.defaultParams?.stop ? { stop_sequences: profile.defaultParams.stop } : {}),
      ...(request.tools?.length ? { tools: mapTools(request.tools) } : {}),
      stream,
    };
  }

  private buildHeaders(profile: ResolvedModelProfile): Record<string, string> {
    const apiKeyEnv = profile.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Environment variable '${apiKeyEnv}' is required for Anthropic provider`);
    }

    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": process.env.ANTHROPIC_VERSION ?? "2023-06-01",
    };
  }
}

function extractAnthropicUsage(parsed: {
  usage?: {
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
  } | undefined;
}): TokenUsage | undefined {
  const u = parsed.usage;
  if (!u) return undefined;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const usage: TokenUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  if (typeof u.cache_read_input_tokens === "number") usage.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === "number") usage.cacheWriteTokens = u.cache_creation_input_tokens;
  return usage;
}

function coalesceMessages(messages: Array<{ role: string; content: string }>): Array<{ role: "user" | "assistant"; content: string }> {
  const output: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const previous = output.at(-1);
    if (previous?.role === role) {
      previous.content += `\n\n${message.content}`;
    } else {
      output.push({ role, content: message.content });
    }
  }
  return output.length > 0 ? output : [{ role: "user", content: "Continue." }];
}

function mapTools(tools: unknown[]): unknown[] {
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const record = tool as Record<string, any>;
    const fn = record.function && typeof record.function === "object" ? record.function : record;
    if (typeof fn.name !== "string") return [];
    return [{
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
    }];
  });
}
