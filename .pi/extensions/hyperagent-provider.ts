import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";

const API = "hyperagent-browser-session";
const PROVIDER = "hyperagent";
const DEFAULT_HYPERAGENT_MODEL = "claude-opus-4-8";
const MAX_THINKING_BUDGET = 16_384;
const MAX_ONLY_THINKING_LEVELS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: "max",
} as const;
const BASE_URL = (process.env.HYPERAGENT_BASE_URL ?? "https://hyperagent.com").replace(/\/+$/, "");
const CDP_URL = process.env.HYPERAGENT_CDP_URL ?? "http://127.0.0.1:9222";
const PROFILE_DIR =
  process.env.HYPERAGENT_BROWSER_PROFILE_DIR ??
  (existsSync("/tmp/hyperagent-browser-profile")
    ? "/tmp/hyperagent-browser-profile"
    : "/workspace/.pi/private/hyperagent-browser-profile");
const AUTO_LAUNCH_BROWSER = process.env.HYPERAGENT_PI_AUTO_LAUNCH !== "0";
const BROWSER_LAUNCH_TIMEOUT_MS = 10_000;

type HyperAgentEffort = "low" | "medium" | "high" | "max";

interface HyperAgentEvent {
  type: string;
  content?: string;
  [key: string]: unknown;
}

interface HyperAgentResult {
  text: string;
  thinking: string;
  toolCalls: unknown[];
  responseModel: string;
}

interface CdpResponse {
  id?: number;
  error?: { message?: string };
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
}

export default function registerHyperAgentProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    name: "HyperAgent Browser Session",
    baseUrl: process.env.HYPERAGENT_BASE_URL ?? "https://hyperagent.com",
    // Authentication is supplied by the active browser/CDP session. Pi still
    // requires a non-empty provider key before it exposes custom models.
    apiKey: "hyperagent-browser-session",
    api: API,
    models: [
      {
        id: DEFAULT_HYPERAGENT_MODEL,
        name: "Claude Opus 4.8 (HyperAgent)",
        reasoning: true,
        thinkingLevelMap: MAX_ONLY_THINKING_LEVELS,
        input: ["text"],
        cost: zeroCost(),
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ],
    streamSimple: streamHyperAgent,
  });
}

function streamHyperAgent(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output = emptyAssistantMessage(model);
    stream.push({ type: "start", partial: cloneMessage(output) });

    try {
      if (options?.signal?.aborted) throw new Error("Request aborted");

      const prompt = toPrompt(context);
      let result = await runHyperAgentInference(model.id, prompt, options);
      if (options?.signal?.aborted) throw new Error("Request aborted");

      const enabledToolNames = context.tools?.map((tool) => tool.name);
      let toolCalls = normalizeToolCalls(result.toolCalls, enabledToolNames);
      if (
        toolCalls.length === 0 &&
        (requiresHostOperation(context) || looksLikeUnparsedToolRequest(result.text, enabledToolNames))
      ) {
        result = await runHyperAgentInference(
          model.id,
          [
            prompt,
            "Host correction: the latest user request requires a real Pi operation, but the previous answer did not request one.",
            "Do not print or describe a tool call as prose.",
            'Respond now with one or more PI_CALL {"name":"available_tool","arguments":{...}} lines and no other visible text.',
            "For independent background Agent launches, emit one PI_CALL line per Agent in this same response.",
          ].join("\n\n"),
          options,
        );
        toolCalls = normalizeToolCalls(result.toolCalls, enabledToolNames);
      }
      if (toolCalls.length === 0 && looksLikeUnparsedToolRequest(result.text, enabledToolNames)) {
        throw new Error("HyperAgent returned a tool request as text that could not be converted into a Pi tool call");
      }
      let contentIndex = 0;

      if (result.thinking.trim()) {
        const thinking = result.thinking.trim();
        output.content.push({ type: "thinking", thinking });
        stream.push({ type: "thinking_start", contentIndex, partial: cloneMessage(output) });
        stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: cloneMessage(output) });
        stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: cloneMessage(output) });
        contentIndex += 1;
      }

      const visibleText = toolCalls.length === 0 ? result.text.trim() : "";
      if (visibleText) {
        const text = visibleText;
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex, partial: cloneMessage(output) });
        stream.push({ type: "text_delta", contentIndex, delta: text, partial: cloneMessage(output) });
        stream.push({ type: "text_end", contentIndex, content: text, partial: cloneMessage(output) });
        contentIndex += 1;
      }

      for (const toolCall of toolCalls) {
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex, partial: cloneMessage(output) });
        stream.push({
          type: "toolcall_delta",
          contentIndex,
          delta: JSON.stringify(toolCall.arguments),
          partial: cloneMessage(output),
        });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: cloneMessage(output) });
        contentIndex += 1;
      }

      output.stopReason = toolCalls.length > 0 ? "toolUse" : "stop";
      output.responseModel = result.responseModel;
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end(output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    }
  })();

  return stream;
}

function toPrompt(context: Context): string {
  const forwardTools = process.env.HYPERAGENT_PI_FORWARD_TOOLS !== "0";
  const tools = forwardTools
    ? context.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
    : undefined;
  const toolContract = tools?.length ? buildUniversalToolContract(tools) : "Answer the request directly.";

  return [
    "You are operating as Pi coding agent. Continue the conversation below and help complete the user's coding task.",
    context.systemPrompt?.trim() && (!context.tools?.length || process.env.HYPERAGENT_PI_FORWARD_SYSTEM_PROMPT === "1")
      ? `<system>\n${context.systemPrompt.trim()}\n</system>`
      : "Answer from the provided conversation. Do not claim to inspect or change files that were not provided.",
    toolContract,
    `<conversation>\n${context.messages
      .map((message) => {
        const serialized = serializeMessage(message);
        return `<message role="${serialized.role}">\n${serialized.content}\n</message>`;
      })
      .join("\n")}\n</conversation>`,
  ].filter((section): section is string => Boolean(section)).join("\n\n");
}

function buildUniversalToolContract(
  tools: Array<{ name: string; description?: string; parameters?: unknown }>,
): string {
  const schemas = tools.map((tool) =>
    JSON.stringify({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {},
    })
  );
  return [
    "Pi host-operation protocol:",
    "Pi owns the workspace tools listed below. Use them whenever the task requires inspecting, searching, executing, editing, writing, validating, or delegating work.",
    "To request an operation, your entire visible response must contain only lines in this format:",
    'PI_CALL {"name":"tool_name","arguments":{"parameter":"value"}}',
    "Normally emit one PI_CALL and wait for its result before deciding the next operation.",
    "When launching independent background Agent tasks in parallel, emit multiple PI_CALL lines in the same response, one per Agent, with run_in_background true.",
    "Never print Agent({...}), tool JSON, PI_CALL, or any other requested operation as explanatory prose.",
    "Never claim an operation succeeded, quote command output, or describe file contents until Pi has returned that operation's result.",
    "Use the exact tool name and parameter schema. Encode multiline strings as valid JSON with \\n escapes.",
    "Do not answer an explicit tool-use request from inference alone; request the operation first.",
    "Available Pi tools, one JSON schema per line:",
    ...schemas,
  ].join("\n");
}

function serializeMessage(message: Message): { role: string; content: string } {
  if (message.role === "user") {
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((item) => (item.type === "text" ? item.text : "[image omitted]")).join("\n"),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: JSON.stringify({
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content: message.content.map((item) => (item.type === "text" ? item.text : "[image omitted]")).join("\n"),
      }),
    };
  }
  return {
    role: "assistant",
    content: message.content
      .map((item) => {
        if (item.type === "text") return item.text;
        if (item.type === "thinking") return `<thinking>${item.thinking}</thinking>`;
        return JSON.stringify({ tool_call: { id: item.id, name: item.name, arguments: item.arguments } });
      })
      .join("\n"),
  };
}

function requiresHostOperation(context: Context): boolean {
  if (!context.tools?.length) return false;
  const latest = context.messages.at(-1);
  if (!latest || latest.role !== "user") return false;
  const text =
    typeof latest.content === "string"
      ? latest.content
      : latest.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
  const toolNames = context.tools.map((tool) => tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const explicitlyRequestsTool = new RegExp(`\\b(?:use|using|with|call|invoke)\\s+(?:the\\s+)?(?:${toolNames})\\s+tool\\b`, "i");
  const imperativeOperation =
    /\b(?:run|execute|inspect|read|list|find|grep|search|write|create|edit|modify|change|replace|delete|rename|test|build|typecheck|lint|validate|delegate|ask\s+(?:a\s+)?subagent)\b/i;
  const concreteTarget =
    /(?:^|\s)(?:\.{0,2}\/|\/|[A-Za-z]:\\)[^\s]+|`[^`]+`|\b(?:npm|pnpm|yarn|node|git|rg|grep|find|ls|cat|sed|bash|sh|python|pytest|tsc)\b/i;
  return explicitlyRequestsTool.test(text) || (imperativeOperation.test(text) && concreteTarget.test(text));
}

function normalizeToolCalls(rawCalls: unknown[] | undefined, enabledToolNames: string[] | undefined): ToolCall[] {
  if (!rawCalls) return [];
  const enabled = new Set(enabledToolNames ?? []);
  return rawCalls.flatMap((raw): ToolCall[] => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    const nested = record.function && typeof record.function === "object"
      ? record.function as Record<string, unknown>
      : undefined;
    const name = String(record.name ?? nested?.name ?? "").trim();
    if (!name) return [];
    if (enabled.size > 0 && !enabled.has(name)) return [];
    const rawArguments = record.arguments ?? record.args ?? nested?.arguments ?? {};
    let args: Record<string, unknown> = {};
    if (typeof rawArguments === "string") {
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        return [];
      }
    } else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
      args = rawArguments as Record<string, unknown>;
    }
    return [{
      type: "toolCall",
      id: String(record.id ?? `call_${randomUUID()}`),
      name,
      arguments: args,
    }];
  });
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: zeroCost(),
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, content: [...message.content] };
}

function toHyperAgentEffort(_level: SimpleStreamOptions["reasoning"]): HyperAgentEffort {
  return "max";
}

function toThinkingBudget(_level: SimpleStreamOptions["reasoning"]): number {
  return MAX_THINKING_BUDGET;
}

function zeroCost(): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

async function runHyperAgentInference(
  modelId: string,
  prompt: string,
  options?: SimpleStreamOptions,
): Promise<HyperAgentResult> {
  const cdp = await CdpSession.connect();
  let threadId: string | undefined;

  try {
    const authenticated = await cdp.evaluate<boolean>(`(async () => {
      const response = await fetch(${JSON.stringify(absoluteHyperAgentUrl("/api/auth/me"))}, { credentials: "include" });
      return response.ok;
    })()`);
    if (!authenticated) throw new Error(`HyperAgent browser session is not authenticated at ${BASE_URL}`);

    const thread = await cdpApiJson<{ id?: string }>(cdp, "/api/threads", {
      method: "POST",
      body: { source: "pi.provider" },
    });
    if (!thread.id) throw new Error("HyperAgent create-thread response did not include an id");
    threadId = thread.id;

    await cdpApiJson(cdp, `/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: {
        modelId,
        maxThinkingTokens: toThinkingBudget(options?.reasoning),
        effort: toHyperAgentEffort(options?.reasoning),
        fastMode: true,
        toolSettings: JSON.stringify(minimalToolSettings()),
      },
    });

    const events = await streamChat(cdp, threadId, prompt, options?.timeoutMs ?? 300_000);
    const errors = events
      .filter((event) => event.type === "error")
      .map((event) => event.content)
      .filter((content): content is string => Boolean(content));
    if (errors.length > 0) throw new Error(`HyperAgent stream error: ${errors.join(" | ")}`);

    const text = events
      .filter((event) => event.type === "text" && typeof event.content === "string")
      .map((event) => event.content)
      .join("");
    const thinking = events
      .filter((event) => event.type === "thinking" && typeof event.content === "string")
      .map((event) => event.content)
      .join("");
    if (!text.trim()) throw new Error("HyperAgent completed without a text response");

    return {
      text,
      thinking,
      toolCalls: parseToolCalls(text),
      responseModel: modelId,
    };
  } finally {
    if (threadId) {
      await cdpApiVoid(cdp, `/api/threads/${encodeURIComponent(threadId)}`, "DELETE").catch(() => undefined);
    }
    cdp.close();
  }
}

async function cdpApiJson<T = unknown>(
  cdp: CdpSession,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const request = JSON.stringify({ requestUrl: absoluteHyperAgentUrl(path), method: options.method ?? "GET", body: options.body });
  return cdp.evaluate<T>(`(async () => {
      const { requestUrl, method, body } = ${request};
      const init = { method, credentials: "include" };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const response = await fetch(requestUrl, init);
      if (!response.ok) throw new Error("HyperAgent HTTP " + response.status + ": " + (await response.text()).slice(0, 500));
      return await response.json();
    })()`);
}

async function cdpApiVoid(cdp: CdpSession, path: string, method: string): Promise<void> {
  const request = JSON.stringify({ requestUrl: absoluteHyperAgentUrl(path), requestMethod: method });
  await cdp.evaluate<void>(`(async () => {
      const { requestUrl, requestMethod } = ${request};
      const response = await fetch(requestUrl, { method: requestMethod, credentials: "include" });
      if (!response.ok) throw new Error("HyperAgent HTTP " + response.status + ": " + (await response.text()).slice(0, 500));
    })()`);
}

async function streamChat(cdp: CdpSession, threadId: string, prompt: string, timeoutMs: number): Promise<HyperAgentEvent[]> {
  const request = JSON.stringify({
    chatUrl: absoluteHyperAgentUrl(`/api/threads/${encodeURIComponent(threadId)}/chat`),
    content: prompt,
    totalTimeoutMs: timeoutMs,
  });
  return cdp.evaluate<HyperAgentEvent[]>(`(async () => {
      const { chatUrl, content, totalTimeoutMs } = ${request};
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), totalTimeoutMs);
      try {
        const response = await fetch(chatUrl, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            sessionId: crypto.randomUUID(),
            searchMode: "native",
            enableExecuteScript: false,
            enablePersistentSandbox: false,
            enableWebpage: false,
            enableSlides: false,
            tablesEnabled: false,
            enableWebSearch: false,
            enableBrowser: false,
            enableImageGeneration: false,
            enableVideoGeneration: false,
            enableAudioGeneration: false,
            enableTranscription: false,
            enableAvatarVideo: false,
            enableExaFindSimilar: false,
            enableExaAnswer: false,
            enableExaResearch: false,
            enableExaWebsets: false,
            enableGeoTools: false,
            hyperAppsEnabled: false,
            documentsEnabled: false,
            enableThreadSearch: false,
            debug: false,
            debugMode: false,
            enabledIntegrations: [],
            integrationMode: "open",
            globalTablesEnabled: false,
            injectPlanMode: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("HyperAgent HTTP " + response.status + ": " + (await response.text()).slice(0, 500));
        if (!response.body) throw new Error("HyperAgent chat response did not include a stream body");

        const events = [];
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const read = await reader.read();
          if (read.done) break;
          buffer += decoder.decode(read.value, { stream: true });
          const blocks = buffer.split("\\n\\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const line = block.split("\\n").find((item) => item.startsWith("data: "));
            const data = line?.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try {
              events.push(JSON.parse(data));
            } catch {
              // Ignore malformed telemetry chunks.
            }
          }
        }
        return events;
      } finally {
        clearTimeout(timeout);
      }
    })()`);
}

function absoluteHyperAgentUrl(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function parseToolCalls(content: string): unknown[] {
  const candidates = [
    content.trim(),
    ...extractPiCallObjects(content),
    ...[...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
      .map((match) => match[1]?.trim())
      .filter((candidate): candidate is string => Boolean(candidate)),
    ...[...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)]
      .map((match) => match[1]?.trim())
      .filter((candidate): candidate is string => Boolean(candidate)),
    ...extractJsonObjects(content),
  ]
    .filter((candidate): candidate is string => Boolean(candidate));

  const calls: unknown[] = [];
  for (const candidate of candidates) {
    try {
      calls.push(...callsFromParsedJson(JSON.parse(candidate) as unknown));
    } catch {
      // Normal text responses are expected.
    }
  }
  calls.push(...extractFunctionStyleToolCalls(content));
  if (calls.length === 0) calls.push(...parsePlainToolRequests(content));
  return dedupeRawToolCalls(calls);
}

function callsFromParsedJson(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const calls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(calls)) return calls;
  const single = record.tool_call ?? record.toolCall;
  if (single && typeof single === "object") return [single];
  if (typeof record.name === "string" && (record.arguments !== undefined || record.args !== undefined)) return [record];
  return [];
}

function extractPiCallObjects(content: string): string[] {
  const results: string[] = [];
  for (const match of content.matchAll(/\bPI_CALL\s*/gi)) {
    const start = content.indexOf("{", (match.index ?? 0) + match[0].length);
    if (start < 0) continue;
    const object = extractBalancedJsonObject(content, start);
    if (object) results.push(object);
  }
  return results;
}

function extractJsonObjects(content: string): string[] {
  const results: string[] = [];
  const starts = [...content.matchAll(/\{\s*"tool_?calls"\s*:/gi)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);
  for (const start of starts) {
    const object = extractBalancedJsonObject(content, start);
    if (object) results.push(object);
  }
  return results;
}

function extractBalancedJsonObject(content: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return undefined;
}

function extractFunctionStyleToolCalls(content: string): unknown[] {
  const calls: unknown[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const pattern = /(?:^|\n)\s*(?:[-*]\s*)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(/g;
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const body = extractBalancedDelimited(content, openIndex, "(", ")");
    if (!body) continue;
    const rawArguments = body.slice(1, -1).trim();
    if (!rawArguments.startsWith("{")) continue;
    try {
      const args = JSON.parse(rawArguments) as unknown;
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      calls.push({ id: `call_${randomUUID()}`, name, arguments: args });
      spans.push({ start: match.index ?? 0, end: openIndex + body.length });
    } catch {
      // Leave malformed pseudo-calls for the correction retry.
    }
  }
  if (calls.length === 0) return calls;

  let residue = content;
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    residue = `${residue.slice(0, span.start)}${residue.slice(span.end)}`;
  }
  if (residue.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim()) return [];
  return calls;
}

function extractBalancedDelimited(content: string, start: number, open: string, close: string): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return undefined;
}

function dedupeRawToolCalls(calls: unknown[]): unknown[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    if (!call || typeof call !== "object") return false;
    const record = call as Record<string, unknown>;
    const nested = record.function && typeof record.function === "object"
      ? record.function as Record<string, unknown>
      : undefined;
    const name = String(record.name ?? nested?.name ?? "");
    const args = record.arguments ?? record.args ?? nested?.arguments ?? {};
    const key = JSON.stringify([name, args]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeUnparsedToolRequest(content: string, enabledToolNames: string[] | undefined): boolean {
  if (!content.trim() || !enabledToolNames?.length) return false;
  if (
    /\bPI_CALL\s*\{|<tool_call>/i.test(content) ||
    /["']?tool_?calls?["']?\s*[:=]\s*[\[{]/i.test(content)
  ) return true;
  return enabledToolNames.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escaped}\\s*\\(`, "m").test(content);
  });
}

function parsePlainToolRequests(content: string): unknown[] {
  const compact = content.replace(/\s+/g, " ").trim();
  const results: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const add = (name: string, args: Record<string, unknown>) => {
    results.push({ id: `call_${randomUUID()}`, name, arguments: args });
  };

  const observation = content.match(/^\s*OBSERVE\s+(read|list|ls|find|grep|shell|bash|run)\s+(.+?)\s*$/im);
  if (observation?.[1] && observation[2]) {
    const op = observation[1].toLowerCase();
    const fields = parseObservationFields(observation[2]);
    const path = fields.path ?? fields.file ?? firstObservationValue(observation[2]);
    const pattern = fields.pattern ?? fields.query;
    const command = fields.command ?? fields.cmd ?? (op === "shell" || op === "bash" || op === "run" ? observation[2].trim() : undefined);

    if (op === "read" && path) add("read", { path: cleanPathLike(path) });
    if ((op === "list" || op === "ls") && path) add("ls", { path: cleanPathLike(path) });
    if (op === "find" && pattern) add("find", { pattern, ...(path ? { path: cleanPathLike(path) } : {}) });
    if (op === "grep" && pattern) add("grep", { pattern, ...(path ? { path: cleanPathLike(path) } : {}) });
    if ((op === "shell" || op === "bash" || op === "run") && command) add("bash", { command });
    if (results.length > 0) return results;
  }

  const read = compact.match(/\bplease\s+read\s+["'`]?([^"'`.,;:\n]+(?:\.[A-Za-z0-9_-]+)?)(?:["'`]|\b)/i);
  if (read?.[1]) {
    add("read", { path: cleanPathLike(read[1]) });
    return results;
  }

  const list = compact.match(/\bplease\s+list\s+["'`]?([^"'`.,;:\n]+)(?:["'`]|\b)/i);
  if (list?.[1]) {
    add("ls", { path: cleanPathLike(list[1]) });
    return results;
  }

  const find = compact.match(/\bplease\s+find\s+files\s+matching\s+["'`]([^"'`]+)["'`](?:\s+in\s+["'`]?([^"'`.,;:\n]+))?/i);
  if (find?.[1]) {
    add("find", { pattern: find[1], ...(find[2] ? { path: cleanPathLike(find[2]) } : {}) });
    return results;
  }

  const grep = compact.match(/\bplease\s+grep\s+["'`]([^"'`]+)["'`](?:\s+in\s+["'`]?([^"'`.,;:\n]+))?/i);
  if (grep?.[1]) {
    add("grep", { pattern: grep[1], ...(grep[2] ? { path: cleanPathLike(grep[2]) } : {}) });
    return results;
  }

  const run = content.match(/^\s*please\s+run:\s*([\s\S]+?)\s*$/im);
  if (run?.[1]) {
    add("bash", { command: run[1].trim() });
    return results;
  }

  const piTool = compact.match(/\bPI_TOOL\s+(read|ls|find|grep|bash)\s+(.+)$/i);
  if (piTool?.[1] && piTool[2]) {
    const name = piTool[1].toLowerCase();
    const tail = piTool[2];
    const path = tail.match(/\bpath=["'`]?([^"'`\s]+)["'`]?/i)?.[1];
    const pattern = tail.match(/\bpattern=["'`]([^"'`]+)["'`]/i)?.[1];
    const command = tail.match(/\bcommand=["'`]([^"'`]+)["'`]/i)?.[1];
    if (name === "read" && path) add("read", { path: cleanPathLike(path) });
    if (name === "ls" && path) add("ls", { path: cleanPathLike(path) });
    if (name === "find" && pattern) add("find", { pattern, ...(path ? { path: cleanPathLike(path) } : {}) });
    if (name === "grep" && pattern) add("grep", { pattern, ...(path ? { path: cleanPathLike(path) } : {}) });
    if (name === "bash" && command) add("bash", { command });
  }

  return results;
}

function parseObservationFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const fieldPattern = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s]+))/g;
  for (const match of value.matchAll(fieldPattern)) {
    fields[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
  }
  return fields;
}

function firstObservationValue(value: string): string | undefined {
  return value.match(/^\s*["'`]?([^"'`\s]+)["'`]?\s*$/)?.[1];
}

function cleanPathLike(value: string): string {
  return value
    .trim()
    .replace(/^(?:file|path)\s*[:=]\s*/i, "")
    .replace(/[).,;:]+$/g, "");
}

function minimalToolSettings(): Record<string, unknown> {
  return {
    "exa-mode": false,
    searchMode: "native",
    "execute-script": false,
    "persistent-sandbox": false,
    webpage: false,
    slides: false,
    tables: false,
    "web-search": false,
    browser: false,
    "image-generation": false,
    "video-generation": false,
    "audio-generation": false,
    transcribeaudio: false,
    "avatar-video": false,
    exafindsimilar: false,
    exaanswer: false,
    exaresearch: false,
    exawebsets: false,
    geocode: false,
    hyperapps: false,
    documents: false,
    searchthreads: false,
    integrationMode: "open",
    enabledIntegrations: [],
    globalTablesEnabled: false,
  };
}

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      let response: CdpResponse;
      try {
        response = JSON.parse(data.toString()) as CdpResponse;
      } catch {
        return;
      }
      if (response.id === undefined) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? "Chrome DevTools Protocol request failed"));
        return;
      }
      const exception = response.result?.exceptionDetails;
      if (exception) {
        pending.reject(new Error(exception.exception?.description ?? exception.text ?? "HyperAgent page evaluation failed"));
        return;
      }
      pending.resolve(response.result?.result?.value);
    });
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("Chrome DevTools Protocol connection closed")));
  }

  static async connect(): Promise<CdpSession> {
    const targets = await getCdpTargetsWithRecovery();
    const origin = new URL(BASE_URL).origin;
    let target = targets.find((candidate) => {
      try {
        return candidate.type === "page" && Boolean(candidate.webSocketDebuggerUrl) && new URL(candidate.url ?? "").origin === origin;
      } catch {
        return false;
      }
    });
    if (!target) {
      await openHyperAgentTarget().catch(() => undefined);
      target = await waitForHyperAgentTarget();
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`No authenticated HyperAgent page found. Open ${BASE_URL} in the supervised browser.`);
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const session = new CdpSession(socket);
    await session.ensureHyperAgentOrigin();
    return session;
  }

  async evaluate<T>(expression: string): Promise<T> {
    return await this.request<T>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
  }

  close(): void {
    this.socket.close();
  }

  async ensureHyperAgentOrigin(): Promise<void> {
    const targetUrl = `${BASE_URL}/threads/new`;
    const origin = new URL(BASE_URL).origin;
    await this.request("Page.enable", {}).catch(() => undefined);
    let navigated = false;
    const deadline = Date.now() + BROWSER_LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const href = await this.evaluate<string>("location.href").catch(() => "");
      try {
        if (new URL(href).origin === origin) return;
      } catch {
        // Keep waiting or navigate below.
      }
      if (!navigated) {
        navigated = true;
        await this.request("Page.navigate", { url: targetUrl }).catch(() => undefined);
      }
      await delay(250);
    }
    throw new Error(`HyperAgent page did not navigate to ${origin} within ${BROWSER_LAUNCH_TIMEOUT_MS}ms`);
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function getCdpTargetsWithRecovery(): Promise<Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>> {
  try {
    return await getCdpTargets();
  } catch (error) {
    if (!AUTO_LAUNCH_BROWSER) throw error;
    await launchSupervisedBrowser();
    return await waitForCdpTargets();
  }
}

async function getCdpTargets(): Promise<Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>> {
  const base = new URL(CDP_URL.replace(/\/+$/, ""));
  const path = `${base.pathname === "/" ? "" : base.pathname}/json/list`;
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: base.hostname,
      port: base.port || "80",
      path,
      method: "GET",
      timeout: 2_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
          reject(new Error(`Could not inspect supervised browser at ${CDP_URL}: HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`HyperAgent supervised browser did not respond at ${CDP_URL} within 2000ms`));
    });
    request.on("error", (error) => {
      reject(new Error(`HyperAgent supervised browser is not reachable at ${CDP_URL}. Start the logged-in browser session and retry. ${error.message}`));
    });
    request.end();
  });
}

async function waitForCdpTargets(): Promise<Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>> {
  const deadline = Date.now() + BROWSER_LAUNCH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = await getCdpTargets();
      if (targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `HyperAgent supervised browser did not become reachable at ${CDP_URL} within ${BROWSER_LAUNCH_TIMEOUT_MS}ms. ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "")
    }`,
  );
}

async function waitForHyperAgentTarget(): Promise<{ type?: string; url?: string; webSocketDebuggerUrl?: string } | undefined> {
  const origin = new URL(BASE_URL).origin;
  const deadline = Date.now() + BROWSER_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const target = (await getCdpTargets()).find((candidate) => {
      try {
        return candidate.type === "page" && Boolean(candidate.webSocketDebuggerUrl) && new URL(candidate.url ?? "").origin === origin;
      } catch {
        return false;
      }
    });
    if (target) return target;
    await delay(250);
  }
  return undefined;
}

async function openHyperAgentTarget(): Promise<void> {
  const base = new URL(CDP_URL.replace(/\/+$/, ""));
  const url = `${BASE_URL}/threads/new`;
  await httpJson(`${base.pathname === "/" ? "" : base.pathname}/json/new?${encodeURIComponent(url)}`, "PUT");
}

async function httpJson(path: string, method: string): Promise<unknown> {
  const base = new URL(CDP_URL.replace(/\/+$/, ""));
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: base.hostname,
      port: base.port || "80",
      path,
      method,
      timeout: 2_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
          reject(new Error(`Chrome DevTools HTTP ${response.statusCode}`));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Chrome DevTools request timed out: ${path}`)));
    request.on("error", reject);
    request.end();
  });
}

async function launchSupervisedBrowser(): Promise<void> {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error(
      "HyperAgent supervised browser is down and no Chromium executable was found. Set HYPERAGENT_CHROME_PATH and retry.",
    );
  }
  cleanupStaleProfileLocks();
  const headless = process.env.HYPERAGENT_BROWSER_HEADLESS
    ? process.env.HYPERAGENT_BROWSER_HEADLESS !== "0"
    : !process.env.DISPLAY;
  const cdp = new URL(CDP_URL);
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-address=${cdp.hostname || "127.0.0.1"}`,
    `--remote-debugging-port=${cdp.port || "9222"}`,
    `--user-data-dir=${PROFILE_DIR}`,
    ...(headless ? ["--headless=new"] : []),
    `${BASE_URL}/threads/new`,
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  await delay(500);
}

function findChromeExecutable(): string | undefined {
  const candidates = [
    process.env.HYPERAGENT_CHROME_PATH,
    "/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((item): item is string => Boolean(item));
  return candidates.find((candidate) => existsSync(candidate));
}

function cleanupStaleProfileLocks(): void {
  for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    try {
      rmSync(`${PROFILE_DIR}/${name}`, { force: true, recursive: true });
    } catch {
      // Best effort. Chrome will report profile-lock issues if cleanup is insufficient.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
