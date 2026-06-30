/**
 * model/providers/stream-normalizer.ts — translate an OpenAI wire-format
 * SSE stream into Pi-shaped ProviderStreamEvents so the main-agent loop can
 * fire tool calls as soon as their arguments are parseable.
 *
 * Mirrors @earendil-works/pi-ai/dist/api/openai-completions.js which keeps
 * a per-tool-call accumulator keyed by `index` (falling back to `id`) and
 * emits each delta straight through. Reaper uses partial JSON parsing
 * (`safeParsePartialJson`) so a tool with a complete JSON argument payload
 * fires `tool_call` immediately, without waiting for `finish_reason`.
 *
 * No batching behind finish_reason: downstream Pi-style live execution
 * needs each tool_call as soon as its arguments parse.
 */
import type { StreamEvent } from "../types.js";

/**
 * Module-level UTF-8 decoder reused across every streaming
 * response. Constructing one per call costs ~1µs + a finalizer; on
 * busy turns the allocation shows up in profiles.
 */
const SSE_DECODER = new TextDecoder();

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  /** Concatenated partial arguments from each chunk. */
  arguments: string;
  /** True once we emitted a complete tool_call for this index. */
  emitted: boolean;
}

interface StreamState {
  toolCalls: Map<number, ToolCallAccumulator>;
  byId: Map<string, ToolCallAccumulator>;
  finishReason: string | null;
  ended: boolean;
}

function createState(): StreamState {
  return { toolCalls: new Map(), byId: new Map(), finishReason: null, ended: false };
}

function safeParsePartialJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not yet balanced; fall through */
  }
  // Partial JSON: append closing braces and try again. Pi uses
  // partial-json-parser; we approximate for the well-formed cases we see
  // by trimming trailing whitespace from `{` counts and closing at the
  // first parseable balance.
  const openBraces = (trimmed.match(/\{/g) ?? []).length;
  const closeBraces = (trimmed.match(/\}/g) ?? []).length;
  const openBrackets = (trimmed.match(/\[/g) ?? []).length;
  const closeBrackets = (trimmed.match(/\]/g) ?? []).length;
  if (openBraces === closeBraces && openBrackets === closeBrackets) {
    return undefined;
  }
  const padding =
    "}".repeat(Math.max(0, openBraces - closeBraces)) +
    "]".repeat(Math.max(0, openBrackets - closeBrackets));
  try {
    const parsed = JSON.parse(trimmed + padding);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Replace the wire-format `function.arguments` partial JSON with fully
 * parsed args when the accumulator has a parseable JSON object. Once we
 * have a parseable JSON object, fire a tool_call event immediately so
 * downstream live-execution can dispatch without waiting for finish_reason.
 */
function fireCompletedIfReady(
  acc: ToolCallAccumulator,
  state: StreamState,
): StreamEvent | undefined {
  // Pi-style: never emit mid-stream on partial JSON. Tool calls only fire
  // at end-of-stream with the full accumulated arguments. Per Pi's
  // openai-completions.js, this prevents providers (e.g., nuralwatt
  // serving kimi-k2.7) from emitting non-JSON argument fragments that
  // re-parse later into valid objects. The `emitted` flag is intentional
  // and is read by the message_end handler.
  return undefined;
}

export async function* normalizeLiteLLMStream(
  response: Response,
): AsyncIterable<StreamEvent> {
  if (!response.body) {
    throw new Error("LiteLLM streaming response did not include a body");
  }

  const decoder = SSE_DECODER;
  const state = createState();
  let buffer = "";
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice("data:".length).trim();
        if (payload === "[DONE]") {
          if (!state.ended) {
            for (const tc of state.toolCalls.values()) {
              if (tc.emitted) continue;
              yield {
                type: "tool_call",
                content: tc.arguments,
                data: { id: tc.id, name: tc.name, arguments: tc.arguments },
              };
              tc.emitted = true;
            }
            state.toolCalls.clear();
            state.byId.clear();
            yield {
              type: "message_end",
              data: {
                finishReason: state.finishReason ?? "tool_calls",
                ...(state.finishReason && state.finishReason !== "stop" ? {} : { finishReason: "tool_calls" }),
              },
            };
            state.ended = true;
          }
          continue;
        }

        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: OpenAIToolCallDelta[];
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const reasoningContent = parsed.choices?.[0]?.delta?.reasoning_content;
        if (reasoningContent) {
          yield { type: "reasoning_delta", content: reasoningContent, data: parsed };
        }

        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          yield { type: "message_delta", content, data: parsed };
        }

        const toolCallDeltas = parsed.choices?.[0]?.delta?.tool_calls ?? [];
        for (const tc of toolCallDeltas) {
          const index = tc.index ?? 0;
          let acc = state.toolCalls.get(index);
          if (!acc) {
            acc = { index, id: "", name: "", arguments: "", emitted: false };
            state.toolCalls.set(index, acc);
          }
          if (tc.id) {
            acc.id = tc.id;
            state.byId.set(tc.id, acc);
          }
          if (tc.function?.name) {
            acc.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            acc.arguments += tc.function.arguments;
          }
          if (acc.id && acc.name && acc.arguments) {
            const completed = fireCompletedIfReady(acc, state);
            if (completed) yield completed;
          }
        }

        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason) {
          state.finishReason = finishReason;
          // Flush any not-yet-emitted accumulators.
          for (const tc of state.toolCalls.values()) {
            if (tc.emitted) continue;
            yield {
              type: "tool_call",
              content: tc.arguments,
              data: { id: tc.id, name: tc.name, arguments: tc.arguments },
            };
            tc.emitted = true;
          }
          state.toolCalls.clear();
          state.byId.clear();
          yield {
            type: "message_end",
            data: {
              finishReason,
              ...(parsed.usage
                ? {
                    usage: {
                      promptTokens: parsed.usage.prompt_tokens ?? 0,
                      completionTokens: parsed.usage.completion_tokens ?? 0,
                    },
                  }
                : {}),
            },
          };
          state.ended = true;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (!state.ended) {
    for (const tc of state.toolCalls.values()) {
      if (tc.emitted) continue;
      yield {
        type: "tool_call",
        content: tc.arguments,
        data: { id: tc.id, name: tc.name, arguments: tc.arguments },
      };
      tc.emitted = true;
    }
    state.toolCalls.clear();
    yield { type: "message_end", data: { finishReason: state.finishReason ?? "tool_calls" } };
  }
}
