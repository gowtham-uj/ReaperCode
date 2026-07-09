import type { GenerateRequest, GenerateResult, ResolvedModelProfile, StreamEvent, TokenUsage } from "../types.js";
import type { ProviderModelClient } from "../gateway.js";
import { extractUsage, OpenAIChatResponseSchema, parseToolArguments } from "./response.js";

export class OpenRouterClient implements ProviderModelClient {
  private readonly baseUrl = "https://openrouter.ai/api/v1";

  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for OpenRouter");

    const body = {
      model: profile.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? profile.defaultParams?.temperature,
      max_tokens: request.maxTokens ?? profile.defaultParams?.maxTokens,
      tools: request.tools,
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/reaper-agent",
        "X-Title": "Reaper",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter request failed: HTTP ${res.status} — ${errText.slice(0, 300)}`);
    }

    const json = OpenAIChatResponseSchema.parse(await res.json());
    const choice = json.choices[0];
    const msg = choice?.message;
    const toolCalls = msg?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name ?? "",
      input: parseToolArguments(tc.function?.arguments ?? tc.input),
    }));
    const usage = extractUsage(json);

    return {
      role: request.role,
      profileName: profile.profileName,
      provider: "openrouter",
      model: json.model ?? profile.model,
      content: msg?.content ?? "",
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(usage ? { usage: usage as TokenUsage } : {}),
      raw: json,
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    const result = await this.generate(request, profile);
    yield { type: "message_start", data: { provider: "openrouter", model: profile.model } };
    yield { type: "message_delta", content: result.content };
    yield {
      type: "message_end",
      data: {
        finishReason: result.finishReason,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }

  async embed(): Promise<any> { throw new Error("OpenRouter embeddings not implemented"); }
}
