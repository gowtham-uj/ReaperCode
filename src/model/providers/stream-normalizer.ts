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

interface StreamState {
  /** Accumulator for tool call deltas keyed by tool call index. */
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  /** Whether we have already emitted message_end for the current stream. */
  ended: boolean;
}

function createState(): StreamState {
  return { toolCalls: new Map(), ended: false };
}

function takeCompletedToolCalls(
  state: StreamState,
  completeOnly: boolean,
): Array<{ id: string; name: string; arguments: string }> | null {
  // When `completeOnly` is true we only want to emit once we have an
  // explicit signal that the stream is finished (a `finish_reason` or
  // `[DONE]` sentinel). Until that signal arrives, keep accumulating.
  if (completeOnly && !state.ended) {
    return null;
  }
  return [...state.toolCalls.values()];
}

export async function* normalizeLiteLLMStream(response: Response): AsyncIterable<StreamEvent> {
  if (!response.body) {
    throw new Error("LiteLLM streaming response did not include a body");
  }

  const decoder = SSE_DECODER;
  const state = createState();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) {
        continue;
      }

      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") {
        const completed = takeCompletedToolCalls(state, true);
        if (completed) {
          for (const tc of completed) {
            yield {
              type: "tool_call",
              content: tc.arguments,
              data: { id: tc.id, name: tc.name, arguments: tc.arguments },
            };
          }
        }
        if (!state.ended) {
          yield { type: "message_end", data: { finishReason: "stop" } };
          state.ended = true;
        }
        continue;
      }

      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: OpenAIToolCallDelta[];
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const reasoningContent = parsed.choices?.[0]?.delta?.reasoning_content;
      if (reasoningContent) {
        yield { type: "reasoning_delta", content: reasoningContent, data: parsed };
      }

      const content = parsed.choices?.[0]?.delta?.content;
      if (content) {
        yield { type: "message_delta", content, data: parsed };
      }

      // Accumulate streamed tool-call deltas so we can emit one fully-formed
      // tool_call event when the stream signals completion. This mirrors the
      // pattern in LiteLLMProviderClient.collectStreamResponse.
      const toolCallDeltas = parsed.choices?.[0]?.delta?.tool_calls ?? [];
      for (const tc of toolCallDeltas) {
        const index = tc.index ?? 0;
        const existing = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        state.toolCalls.set(index, existing);
      }

      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason) {
        // Mark the stream as finished BEFORE emitting so
        // takeCompletedToolCalls returns the accumulated tool calls rather
        // than null. Without this ordering, the tool_call events would be
        // dropped because ended is only set after the emit.
        state.ended = true;
        // Emit each accumulated tool call as its own event, then the finish
        // marker. This lets the main-agent loop bind the tool call to its
        // id and run validation/execution as soon as the upstream signals
        // `tool_calls`.
        const completed = takeCompletedToolCalls(state, true);
        if (completed) {
          for (const tc of completed) {
            yield {
              type: "tool_call",
              content: tc.arguments,
              data: { id: tc.id, name: tc.name, arguments: tc.arguments },
            };
          }
        }
        yield {
          type: "message_end",
          data: { finishReason, ...(parsed.usage ? { usage: parsed.usage } : {}) },
        };
      }
    }
  }
  // Stream ended without an explicit finish_reason; flush any partial
  // tool calls we accumulated so downstream consumers still see them.
  if (!state.ended) {
    for (const tc of state.toolCalls.values()) {
      yield {
        type: "tool_call",
        content: tc.arguments,
        data: { id: tc.id, name: tc.name, arguments: tc.arguments },
      };
    }
    yield { type: "message_end" };
  }
}
