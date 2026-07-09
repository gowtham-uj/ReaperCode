import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ResolvedModelProfile,
  StreamEvent,
} from "../types.js";
import type { ProviderModelClient } from "../gateway.js";

interface ResponsesToolCall {
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

function apiBase(profile: ResolvedModelProfile): string {
  return (profile.apiBase ?? "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
}

function apiKey(profile: ResolvedModelProfile): string {
  const envName = profile.apiKeyEnv ?? "OPENAI_CODEX_ACCESS_TOKEN";
  const value = process.env[envName];
  if (!value) throw new Error(`openai-codex requires ${envName} in the environment`);
  return value;
}

function requestId(profile: ResolvedModelProfile): string {
  return `reaper-${profile.profileName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toResponsesTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const converted: unknown[] = [];
  for (const item of tools) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const fn = t.function && typeof t.function === "object" ? t.function as Record<string, unknown> : undefined;
    const name = typeof t.name === "string" ? t.name : typeof fn?.name === "string" ? fn.name : undefined;
    if (!name) continue;
    const description = typeof t.description === "string" ? t.description : typeof fn?.description === "string" ? fn.description : "";
    const parameters = (t.inputSchema ?? fn?.parameters ?? { type: "object", properties: {} }) as unknown;
    converted.push({ type: "function", name, description, strict: false, parameters });
  }
  return converted.length ? converted : undefined;
}

function toResponsesInput(messages: GenerateRequest["messages"]): unknown[] {
  const input: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      input.push({ type: "function_call_output", call_id: msg.tool_call_id ?? msg.name ?? "call_unknown", output: msg.content ?? "" });
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: msg.content }] });
      }
      for (const tc of msg.tool_calls ?? []) {
        input.push({
          type: "function_call",
          id: tc.id.startsWith("fc_") ? tc.id : `fc_${tc.id.replace(/^call_/, "")}`,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }
    input.push({ role: msg.role === "system" ? "developer" : msg.role, content: [{ type: "input_text", text: msg.content ?? "" }] });
  }
  return input;
}

function extractContent(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  const chunks: string[] = [];
  for (const item of response?.output ?? []) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (typeof part?.text === "string") chunks.push(part.text);
      }
    }
  }
  return chunks.join("");
}

function extractToolCalls(response: any): Array<{ id: string; name: string; function: { name: string; arguments: string } }> | undefined {
  const calls: Array<{ id: string; name: string; function: { name: string; arguments: string } }> = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "function_call") continue;
    const fc = item as ResponsesToolCall;
    const id = fc.call_id ?? fc.id ?? `call_${calls.length}`;
    const name = fc.name ?? "";
    if (!name) continue;
    calls.push({ id, name, function: { name, arguments: fc.arguments ?? "{}" } });
  }
  return calls.length ? calls : undefined;
}

function finishReason(response: any, toolCalls: unknown[] | undefined): string {
  if (toolCalls?.length) return "tool_use";
  const status = String(response?.status ?? "");
  if (status === "completed") return "stop";
  if (status === "incomplete") return "length";
  return "stop";
}

function parseResponsesSse(text: string): any {
  const output: any[] = [];
  const contentParts: string[] = [];
  let finalResponse: any = undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    let ev: any;
    try { ev = JSON.parse(raw); } catch { continue; }
    const type = String(ev.type ?? "");
    if (type === "response.output_text.delta" && typeof ev.delta === "string") {
      contentParts.push(ev.delta);
    } else if ((type === "response.output_item.done" || type === "response.output_item.added") && ev.item) {
      if (ev.item.type === "function_call") output.push(ev.item);
    } else if (type === "response.completed" && ev.response) {
      finalResponse = ev.response;
    }
  }
  const response = finalResponse ?? { status: "completed", output };
  if (output.length) response.output = [...(response.output ?? []), ...output];
  if (contentParts.length) response.output_text = contentParts.join("");
  return response;
}

export class CodexResponsesClient implements ProviderModelClient {
  async generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult> {
    const rid = requestId(profile);
    const instructions = request.system ?? "You are Reaper's main agent.";
    const tools = toResponsesTools(request.tools);
    const body: Record<string, unknown> = {
      model: profile.model,
      instructions,
      input: toResponsesInput(request.messages),
      store: false,
      stream: true,
      reasoning: { effort: profile.defaultParams?.reasoningEffort ?? "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: ["Bearer", apiKey(profile)].join(" "),
        "Content-Type": "application/json",
        Accept: "application/json",
        session_id: rid,
        "x-client-request-id": rid,
      },
      body: JSON.stringify(body),
    };
    if (request.abortSignal) init.signal = request.abortSignal;
    const resp = await fetch(`${apiBase(profile)}/responses`, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Codex Responses request failed status=${resp.status} body=${text.slice(0, 1000)}`);
    }
    const json = parseResponsesSse(text);
    const toolCalls = extractToolCalls(json);
    return {
      role: profile.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model: profile.model,
      content: extractContent(json),
      ...(toolCalls ? { toolCalls } : {}),
      finishReason: finishReason(json, toolCalls),
      raw: json,
    };
  }

  async *stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent> {
    yield { type: "message_start", data: { provider: profile.provider, model: profile.model } };
    try {
      const result = await this.generate(request, profile);
      if (result.reasoningContent) yield { type: "reasoning_delta", content: result.reasoningContent };
      if (result.content) yield { type: "message_delta", content: result.content };
      for (const tc of (result.toolCalls ?? []) as Array<any>) {
        yield { type: "tool_call", data: { id: tc.id, name: tc.name, args: JSON.parse(tc.function?.arguments || "{}") } };
      }
      yield { type: "message_end", data: { finishReason: result.finishReason ?? "stop" } };
    } catch (err) {
      yield { type: "error", data: { message: err instanceof Error ? err.message : String(err), retryable: false } };
      yield { type: "message_end", data: { finishReason: "error" } };
    }
  }

  async embed(_request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult> {
    throw new Error(`Codex Responses provider does not support embeddings for ${profile.provider}`);
  }
}
