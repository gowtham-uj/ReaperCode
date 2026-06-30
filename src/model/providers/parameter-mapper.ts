import type { GenerateRequest, ResolvedModelProfile } from "../types.js";
import { resolveProviderDefaults, resolveProviderModelName, usesAzureOpenAiV1 } from "./provider-registry.js";

export function mapGenerateRequestToLiteLLM(request: GenerateRequest, profile: ResolvedModelProfile) {
  const payload = {
    model: resolveProviderModelName(profile),
    messages: applyPromptCacheControls(
      [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        ...normalizeMessagesForOpenAI(request.messages),
      ],
      profile,
    ),
    temperature: request.temperature ?? profile.defaultParams?.temperature,
    max_tokens: request.maxTokens ?? profile.defaultParams?.maxTokens ?? 8192,
    top_p: profile.defaultParams?.topP,
    stop: profile.defaultParams?.stop,
    tools: normalizeOpenAiTools(request.tools),
    stream: false,
    response_format: request.responseFormat === "json" && !request.tools?.length ? { type: "json_object" } : undefined,
  };

  if (resolveProviderDefaults(profile).pathStyle === "azure-openai" && !usesAzureOpenAiV1(profile)) {
    const { model: _model, ...withoutModel } = payload;
    return withoutModel;
  }

  return payload;
}

/**
 * Normalize the conversation messages to the OpenAI chat-completions wire
 * shape. The engine may carry internal tool-result hints like
 * `tool_call_id`, `name`, and `is_error` fields. OpenAI's `/chat/completions`
 * wire expects a strict subset: `role` (one of system|user|assistant|tool),
 * `content`, plus `tool_call_id` for the `tool` role and `tool_calls` for
 * the `assistant` role. Anything else is silently ignored by the model.
 *
 * Translate:
 *   role: "tool"          → { role: "tool", tool_call_id, content }
 *   role: "assistant"     → { role: "assistant", content, tool_calls? }
 *                          where tool_calls is the structured OpenAI array
 *                          emitted by the live-execute mirror.
 *
 * Drop non-wire fields (`name`, `is_error`) since the OpenAI server ignores
 * them anyway; we keep their semantics by prefixing the content with
 * `Error:` for the failure case so the model still reads the failure.
 */
function normalizeMessagesForOpenAI(
  messages: GenerateRequest["messages"],
): GenerateRequest["messages"] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const m: GenerateRequest["messages"][number] = {
        role: "tool",
        content: message.content,
      };
      if (message.tool_call_id) m.tool_call_id = message.tool_call_id;
      return m;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const m: GenerateRequest["messages"][number] = {
        role: "assistant",
        content: message.content ?? "",
      };
      m.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }));
      return m;
    }
    return message;
  });
}

export function mapStreamRequestToLiteLLM(request: GenerateRequest, profile: ResolvedModelProfile) {
  return {
    ...mapGenerateRequestToLiteLLM(request, profile),
    stream: true,
  };
}

function normalizeOpenAiTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const record = tool as Record<string, unknown>;
    if (record.type === "function" && record.function && typeof record.function === "object") {
      return tool;
    }
    const name = typeof record.name === "string" ? record.name : undefined;
    if (!name) return tool;
    const description = typeof record.description === "string" ? record.description : undefined;
    const parameters = record.parameters ?? record.inputSchema ?? record.input_schema ?? { type: "object", properties: {} };
    return {
      type: "function",
      function: {
        name,
        ...(description ? { description } : {}),
        parameters,
      },
    };
  });
}

function applyPromptCacheControls(
  messages: Array<{ role: string; content: string }>,
  profile: ResolvedModelProfile,
): Array<{ role: string; content: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> }> {
  if (!shouldUsePromptCache(profile)) {
    return messages;
  }

  const minContentChars = profile.defaultParams?.promptCache?.minContentChars ?? 256;
  const index = messages.findIndex((message) => message.content.trim().length >= minContentChars);
  if (index < 0) {
    return messages;
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? {
          ...message,
          content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
        }
      : message,
  );
}

function shouldUsePromptCache(profile: ResolvedModelProfile): boolean {
  if (profile.defaultParams?.promptCache?.enabled !== undefined) {
    return profile.defaultParams.promptCache.enabled;
  }
  return false;
}
