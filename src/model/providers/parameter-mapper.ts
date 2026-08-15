import type { GenerateRequest, ResolvedModelProfile } from "../types.js";
import { isProvider, normalizeModelId, resolveThinkingMode } from "../provider-quirks.js";
import { resolveProviderDefaults, resolveProviderModelName, usesAzureOpenAiV1 } from "./provider-registry.js";

export function mapGenerateRequestToLiteLLM(request: GenerateRequest, profile: ResolvedModelProfile) {
  const payload = {
    model: resolveProviderModelName(profile),
    messages: applyPromptCacheControls(
      [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        ...normalizeMessagesForOpenAI(request.messages, profile),
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
    // Thinking-capable OpenAI-compatible vendors (MiniMax) accept an
    // explicit thinking toggle. Default enabled; only wire "disabled".
    ...(isThinkingTogglableOpenAiVendor(profile) && resolveThinkingMode(profile) === "disabled"
      ? { thinking: { type: "disabled" } }
      : {}),
    // OpenAI reasoning models (o-series, GPT-5.0+) surface thinking via
    // `reasoning_effort`, not a `thinking` toggle and not a
    // `reasoning_content` echo. Forward the configured effort when
    // present; these endpoints never require reasoning echo-back.
    ...(resolveReasoningEffort(profile) !== undefined
      ? { reasoning_effort: resolveReasoningEffort(profile) }
      : {}),
  };

  if (resolveProviderDefaults(profile).pathStyle === "azure-openai" && !usesAzureOpenAiV1(profile)) {
    const { model: _model, ...withoutModel } = payload;
    return withoutModel;
  }

  return payload;
}

function isThinkingTogglableOpenAiVendor(profile: ResolvedModelProfile): boolean {
  return isProvider(profile, "minimax") || isProvider(profile, "minimax-oauth") || isProvider(profile, "deepseek");
}

/**
 * OpenAI reasoning models surface thinking via the `reasoning_effort`
 * request knob (Responses/Chat Completions), NOT a `thinking` toggle and
 * NOT a `reasoning_content` echo. This covers the o-series (o1/o3/o4)
 * and the GPT-5 family (gpt-5, gpt-5.1, gpt-5-mini, gpt-6, …).
 *
 * These endpoints reject `reasoning_content` on assistant messages, so
 * we must not echo reasoning back to them; instead we forward effort.
 */
function isOpenAiReasoningEffortModel(profile: ResolvedModelProfile): boolean {
  const model = normalizeModelId(profile.model);
  return /^o\d/.test(model) || /^gpt-(?:5|[6-9])/.test(model);
}

/**
 * Whether a model's reasoning channel is the `reasoning_content` echo
 * (DeepSeek thinking mode, MiniMax, and strict OpenAI-compatible
 * reasoning endpoints). OpenAI `reasoning_effort` models do NOT accept
 * the echo, so they are excluded here.
 */
function reasoningSupportsContentEcho(profile: ResolvedModelProfile): boolean {
  return !isOpenAiReasoningEffortModel(profile);
}

/**
 * Resolve the `reasoning_effort` value to forward for OpenAI reasoning
 * models. Disabled thinking maps to "none"; numeric legacy effort
 * (0–100) collapses to low/medium/high. Returns undefined for models
 * that don't take `reasoning_effort`.
 */
function resolveReasoningEffort(profile: ResolvedModelProfile): string | undefined {
  if (!isOpenAiReasoningEffortModel(profile)) return undefined;
  if (resolveThinkingMode(profile) === "disabled") return "none";
  const effort = profile.defaultParams?.reasoningEffort;
  if (typeof effort === "number") {
    if (effort <= 33) return "low";
    if (effort <= 66) return "medium";
    return "high";
  }
  return effort ?? "medium";
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
  profile: ResolvedModelProfile,
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
    if (message.role === "assistant") {
      // Round-trip the reasoning/thinking channel the previous turn
      // emitted. DeepSeek's thinking mode (and other strict
      // OpenAI-compatible reasoning models) reject a follow-up request
      // with a 400 unless an assistant message that produced
      // `reasoning_content` carries that same field back on the next
      // turn. The engine stores it as `reasoning`; `reasoningContent`
      // and `reasoning_content` cover messages built elsewhere.
      const reasoning = (message as GenerateRequest["messages"][number] & {
        reasoning_content?: string;
        reasoningContent?: string;
      }).reasoning ??
        (message as { reasoning_content?: string }).reasoning_content ??
        (message as { reasoningContent?: string }).reasoningContent;

      const m: GenerateRequest["messages"][number] & {
        reasoning_content?: string;
      } = {
        role: "assistant",
        content: message.content ?? "",
      };
      // Only echo reasoning for models that accept (and enforce) the
      // `reasoning_content` channel. Reasoning-aware models reject the
      // field; regular chat models silently ignore it, so gate it to
      // avoid tripping strict OpenAI reasoning endpoints (o-series,
      // GPT-5.0+) that use `reasoning_effort` instead.
      if (reasoning && reasoningSupportsContentEcho(profile)) {
        m.reasoning_content = reasoning;
      }
      if (message.tool_calls?.length) {
        m.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        }));
      }
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
