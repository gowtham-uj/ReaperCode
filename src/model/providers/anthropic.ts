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
import { anthropicAuthHeaderForProvider } from "../provider-quirks.js";
import { AnthropicMessagesResponseSchema } from "./response.js";

export interface AnthropicClientOptions {
  fetchImpl?: typeof fetch;
  /**
   * Override the base URL for Anthropic-compatible endpoints.
   * Used by OAuth-style providers (e.g. minimax-oauth) that proxy
   * the Anthropic Messages API under their own origin.
   */
  baseUrl?: string;
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
    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
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
    // Compose caller-supplied abort signal with the profile timeout so both
    // can interrupt a streaming read mid-flight.
    const timeoutSignal = profile.timeoutMs
      ? AbortSignal.timeout(profile.timeoutMs)
      : undefined;
    const composedSignal = composeAbortSignals(request.abortSignal, timeoutSignal);

    const body = this.buildBody(request, profile, true);

    const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.buildHeaders(profile),
      body: JSON.stringify(body),
      ...(composedSignal ? { signal: composedSignal } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher as NonNullable<Parameters<typeof fetch>[1]> extends { dispatcher?: infer D } ? D : never } : {}),
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Anthropic stream failed: HTTP ${response.status} - ${errText.slice(0, 500)}`);
    }

    yield* parseAnthropicSseStream(response.body, composedSignal);
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

    const authHeader = anthropicAuthHeaderForProvider(profile);

    return {
      "content-type": "application/json",
      [authHeader]: apiKey.trim(),
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

/**
 * Compose two optional abort signals into a single AbortSignal that fires
 * when either source aborts. Returns undefined when both are missing so
 * callers can pass `{ signal: undefined }` straight through to fetch.
 */
function composeAbortSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (!a && b) return b;
  const combined = new AbortController();
  const onAbort = () => combined.abort();
  a!.addEventListener("abort", onAbort, { once: true });
  b!.addEventListener("abort", onAbort, { once: true });
  if (a!.aborted || b!.aborted) combined.abort();
  return combined.signal;
}

interface AnthropicStreamState {
  // The Anthropic SSE protocol interleaves text and tool_use blocks by
  // content_block index. We track the per-block kind and accumulated
  // input JSON so we can emit a complete tool_call once the block closes.
  blocks: Array<{
    kind: "text" | "tool_use" | "thinking" | "unknown";
    id?: string;
    name?: string;
    inputJson: string;
    text: string;
    thinking: string;
  }>;
  model: string | undefined;
  messageId: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  stopReason: string | undefined;
}

/**
 * Parse an Anthropic SSE event stream from a `text/event-stream` body and
 * yield normalized StreamEvents. Handles:
 *   - message_start → message_start
 *   - content_block_start(kind=text) → no event yet (text deltas follow)
 *   - content_block_start(kind=tool_use) → no event yet (input_json_delta follows)
 *   - content_block_delta(kind=text_delta) → message_delta
 *   - content_block_delta(kind=input_json_delta) → buffered
 *   - content_block_stop(kind=tool_use) → tool_call
 *   - content_block_stop(kind=text) → no event
 *   - message_delta → carries final stop_reason + output_tokens (yielded at message_end)
 *   - message_stop → message_end
 *   - ping → ignored
 *   - error → throws a readable Error
 *
 * Aborts cleanly when the supplied signal fires (mid-stream read).
 */
export async function* parseAnthropicSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  let buffer = "";
  const state: AnthropicStreamState = {
    blocks: [],
    model: undefined,
    messageId: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    stopReason: undefined,
  };

  // We emit message_start first so downstream normalizers can latch the model id.
  yield { type: "message_start", data: { provider: "anthropic", model: "anthropic" } };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Anthropic stream aborted", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE messages are separated by a blank line (\n\n). Each event line
      // starts with `event: ` and the next non-empty line starts with `data: `.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(rawEvent);
        if (!parsed) continue;
        for (const ev of handleAnthropicSseEvent(parsed, state)) {
          yield ev;
        }
      }
    }
  } catch (error) {
    try { reader.cancel(); } catch { /* best-effort */ }
    throw error;
  }

  // Flush any trailing data without a closing blank line.
  if (buffer.trim().length > 0) {
    const parsed = parseSseEvent(buffer);
    if (parsed) {
      for (const ev of handleAnthropicSseEvent(parsed, state)) {
        yield ev;
      }
    }
  }

  // Emit message_end with whatever usage we accumulated.
  const usage: TokenUsage | undefined =
    state.inputTokens !== undefined || state.outputTokens !== undefined
      ? {
          inputTokens: state.inputTokens ?? 0,
          outputTokens: state.outputTokens ?? 0,
          ...(state.cacheReadTokens !== undefined ? { cacheReadTokens: state.cacheReadTokens } : {}),
          ...(state.cacheWriteTokens !== undefined ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
        }
      : undefined;
  yield {
    type: "message_end",
    data: {
      ...(state.stopReason ? { finishReason: state.stopReason } : {}),
      ...(usage ? { usage } : {}),
      ...(state.messageId ? { messageId: state.messageId } : {}),
      ...(state.model ? { model: state.model } : {}),
    },
  };
}

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

function parseSseEvent(raw: string): ParsedSseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const piece = line.slice(6);
      data += data.length > 0 ? `\n${piece}` : piece;
    }
  }
  if (!data) return null;
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(data);
  } catch {
    // Anthropic may emit `[DONE]` style terminators on some proxies; treat
    // them as benign no-ops so we still emit our synthetic message_end.
    return null;
  }
  return { event, data: parsedData };
}

function* handleAnthropicSseEvent(parsed: ParsedSseEvent, state: AnthropicStreamState): Iterable<StreamEvent> {
  const { event, data } = parsed;
  if (event === "ping") return;
  if (event === "error") {
    const errObj = (data && typeof data === "object" ? (data as { error?: { message?: string; type?: string } }).error : undefined);
    const message = errObj?.message ?? "Anthropic stream error";
    throw new Error(`Anthropic stream error: ${message}`);
  }
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;

  if (event === "message_start") {
    const message = record.message as { id?: string; model?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
    if (message?.id) state.messageId = message.id;
    if (message?.model) state.model = message.model;
    const usage = message?.usage;
    if (usage) {
      if (typeof usage.input_tokens === "number") state.inputTokens = usage.input_tokens;
      if (typeof usage.cache_read_input_tokens === "number") state.cacheReadTokens = usage.cache_read_input_tokens;
      if (typeof usage.cache_creation_input_tokens === "number") state.cacheWriteTokens = usage.cache_creation_input_tokens;
    }
    return;
  }

  if (event === "content_block_start") {
    const index = typeof record.index === "number" ? record.index : state.blocks.length;
    const block = record.content_block as { type?: string; id?: string; name?: string } | undefined;
    const kind = (block?.type === "text" || block?.type === "tool_use" || block?.type === "thinking")
      ? block.type
      : "unknown";
    while (state.blocks.length <= index) {
      state.blocks.push({ kind: "unknown", inputJson: "", text: "", thinking: "" });
    }
    state.blocks[index] = {
      kind,
      ...(block?.id ? { id: block.id } : {}),
      ...(block?.name ? { name: block.name } : {}),
      inputJson: "",
      text: "",
      thinking: "",
    };
    return;
  }

  if (event === "content_block_delta") {
    const index = typeof record.index === "number" ? record.index : 0;
    const block = state.blocks[index];
    const delta = record.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
    if (!block || !delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      block.text += delta.text;
      yield { type: "message_delta", content: delta.text };
      return;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      block.inputJson += delta.partial_json;
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      block.thinking += delta.thinking;
      // Reasoning deltas flow through the same channel for downstream consumers
      // that haven't yet wired a separate reasoning event type.
      yield { type: "message_delta", content: "", reasoning: delta.thinking };
      return;
    }
    return;
  }

  if (event === "content_block_stop") {
    const index = typeof record.index === "number" ? record.index : 0;
    const block = state.blocks[index];
    if (!block) return;
    if (block.kind === "tool_use") {
      let parsed: Record<string, unknown> = {};
      if (block.inputJson.length > 0) {
        try {
          parsed = JSON.parse(block.inputJson) as Record<string, unknown>;
        } catch {
          parsed = { _raw: block.inputJson };
        }
      }
      const toolCall = {
        id: block.id ?? `toolu_${index}`,
        name: block.name ?? "unknown",
        arguments: JSON.stringify(parsed),
      };
      yield { type: "tool_call", data: toolCall };
    }
    return;
  }

  if (event === "message_delta") {
    const delta = record.delta as { stop_reason?: string; stop_sequence?: string | null } | undefined;
    if (delta?.stop_reason) state.stopReason = delta.stop_reason;
    const usage = record.usage as { output_tokens?: number } | undefined;
    if (usage && typeof usage.output_tokens === "number") {
      state.outputTokens = usage.output_tokens;
    }
    return;
  }

  if (event === "message_stop") {
    return;
  }
}
