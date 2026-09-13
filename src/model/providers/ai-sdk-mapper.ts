/**
 * Translation between Reaper's `GenerateRequest` vocabulary and the AI SDK's
 * `ModelMessage` / tool-set vocabulary.
 *
 * Reaper's internal message shape is OpenAI-chat-flavored: string content,
 * `tool_calls` on the assistant turn, and `tool` messages carrying a
 * `tool_call_id`. The AI SDK models the same conversation as typed content
 * parts, so every conversion happens here rather than being spread across
 * the client.
 */

import { jsonSchema, type ModelMessage, type Tool, type ToolSet } from "ai";

import type { GenerateRequest, TokenUsage } from "../types.js";

interface ReaperMessage extends GenerateRequest {
  messages: GenerateRequest["messages"];
}

/**
 * Convert Reaper messages into AI SDK `ModelMessage`s.
 *
 * Assistant tool calls become `tool-call` parts; `tool` role messages are
 * matched back to the call they answer so providers that validate the pairing
 * (Anthropic, Bedrock) accept the transcript.
 */
export function toModelMessages(request: ReaperMessage): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const out: ModelMessage[] = [];

  for (const message of request.messages) {
    const role = message.role;
    if (role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (role === "tool") {
      const toolCallId = message.tool_call_id ?? "";
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName: message.name ?? toolNames.get(toolCallId) ?? "tool",
          output: message.is_error
            ? { type: "error-text", value: message.content }
            : { type: "text", value: message.content },
        }],
      });
      continue;
    }

    // assistant
    const parts: Array<Record<string, unknown>> = [];
    if (message.reasoning) parts.push({ type: "reasoning", text: message.reasoning });
    if (message.content) parts.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
      parts.push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
    if (parts.length === 0) parts.push({ type: "text", text: "" });
    out.push({ role: "assistant", content: parts } as ModelMessage);
  }

  return out;
}

/**
 * Convert Reaper's tool descriptors into an AI SDK `ToolSet`.
 *
 * Reaper passes either its own `{ name, description, inputSchema }` shape or
 * the OpenAI `{ type: "function", function: {...} }` envelope; both appear in
 * existing configs, so both are accepted. Tools have no `execute` — the agent
 * loop runs them, so the SDK must return the call rather than resolve it.
 */
export function toToolSet(tools: unknown[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined;
  const out: ToolSet = {};
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const fn = record.type === "function" && isRecord(record.function)
      ? record.function
      : record;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (!name) continue;
    const schema = fn.parameters ?? fn.inputSchema ?? fn.input_schema ?? { type: "object", properties: {} };
    const description = typeof fn.description === "string" ? fn.description : undefined;
    out[name] = {
      ...(description ? { description } : {}),
      inputSchema: jsonSchema(schema as never),
    } as Tool;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Convert AI SDK tool calls back into the OpenAI-chat tool-call objects the
 * rest of Reaper (executor, transcript, session log) already understands.
 */
export function fromToolCalls(
  calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>,
): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  return calls.map((call) => ({
    id: call.toolCallId,
    type: "function" as const,
    function: {
      name: call.toolName,
      arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}),
    },
  }));
}

/** Normalize AI SDK usage into Reaper's `TokenUsage`, dropping absent fields. */
export function fromUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = numberOrZero(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = numberOrZero(usage.outputTokens ?? usage.completionTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  // Providers that support caching but did not hit it report 0. Reporting a
  // zero here would make "no cache" indistinguishable from "cache miss" for
  // consumers that treat the field's presence as the signal.
  const cacheRead = positive(usage.cachedInputTokens);
  const cacheWrite = positive(usage.cacheCreationInputTokens);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function parseArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function numberOrZero(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = numberOrZero(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
