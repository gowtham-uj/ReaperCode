import type { GenerateRequest, ResolvedModelProfile } from "../types.js";
import { resolveProviderDefaults, resolveProviderModelName, usesAzureOpenAiV1 } from "./provider-registry.js";

export function mapGenerateRequestToLiteLLM(request: GenerateRequest, profile: ResolvedModelProfile) {
  const payload = {
    model: resolveProviderModelName(profile),
    messages: applyPromptCacheControls(
      [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        ...request.messages,
      ],
      profile,
    ),
    temperature: request.temperature ?? profile.defaultParams?.temperature,
    max_tokens: request.maxTokens ?? profile.defaultParams?.maxTokens ?? 8192,
    top_p: profile.defaultParams?.topP,
    stop: profile.defaultParams?.stop,
    tools: request.tools,
    stream: false,
    response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
  };

  if (resolveProviderDefaults(profile).pathStyle === "azure-openai" && !usesAzureOpenAiV1(profile)) {
    const { model: _model, ...withoutModel } = payload;
    return withoutModel;
  }

  return payload;
}

export function mapStreamRequestToLiteLLM(request: GenerateRequest, profile: ResolvedModelProfile) {
  return {
    ...mapGenerateRequestToLiteLLM(request, profile),
    stream: true,
  };
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
