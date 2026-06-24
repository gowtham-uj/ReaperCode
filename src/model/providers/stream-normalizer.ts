import type { StreamEvent } from "../types.js";

/**
 * Module-level UTF-8 decoder reused across every streaming
 * response. Constructing one per call costs ~1µs + a finalizer; on
 * busy turns the allocation shows up in profiles.
 */
const SSE_DECODER = new TextDecoder();

export async function* normalizeLiteLLMStream(response: Response): AsyncIterable<StreamEvent> {
  if (!response.body) {
    throw new Error("LiteLLM streaming response did not include a body");
  }

  const decoder = SSE_DECODER;
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
        yield { type: "message_end" };
        continue;
      }

      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
      };
      const reasoningContent = parsed.choices?.[0]?.delta?.reasoning_content;
      if (reasoningContent) {
        yield { type: "reasoning_delta", content: reasoningContent, data: parsed };
      }

      const content = parsed.choices?.[0]?.delta?.content;
      if (content) {
        yield { type: "message_delta", content, data: parsed };
      }

      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason) {
        yield { type: "message_end", data: { finishReason } };
      }
    }
  }
}
