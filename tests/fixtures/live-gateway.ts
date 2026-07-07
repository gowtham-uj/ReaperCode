import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ConfiguredModelGateway } from "../../src/model/gateway.js";
import { ResilientModelGateway } from "../../src/model/retry-orchestrator.js";
import { ProviderMultiplexerClient } from "../../src/model/providers/provider-client.js";
import type { ModelGateway } from "../../src/model/types.js";
import { createValidConfig } from "./phase0.js";
import { writeLiveLlmLog } from "./live-llm-log.js";
import {
  getDefaultAnthropicModel,
  getDefaultAzureOpenAiModel,
  getDefaultCerebrasModel,
  getDefaultCrazyRouterModel,
  getDefaultDeepInfraModel,
  getDefaultDeepSeekLatencyFallbackModel,
  getDefaultDeepSeekModel,
  getDefaultMimoModel,
  getDefaultNuralWattModel,
  getDefaultOpenAiModel,
  getDefaultOpenRouterModel,
} from "./live-models.js";

type SupportedLiveProvider = "deepinfra" | "deepseek" | "cerebras" | "openrouter" | "crazyrouter" | "openai" | "anthropic" | "minimax" | "minimax-oauth" | "mimo" | "nuralwatt" | "nuralwatt2" | "azure";

interface LiveProviderDefaults {
  provider: SupportedLiveProvider;
  model: string;
  apiKeyEnv?: string;
  apiBase?: string;
  maxContextTokens: number;
  maxTokens: number;
}

export function createLiveReaperConfig(provider?: string, model?: string) {
  loadWorkspaceDotEnv();
  const defaults = getProviderDefaults(provider ?? getLiveProvider(), model);
  return createLiveConfigFromDefaults(defaults);
}

export function createLiveReaperGateway(testName: string, provider?: string, model?: string) {
  const config = createLiveReaperConfig(provider, model);
  return createGatewayFromConfig(config, testName);
}

export function createLiveDeepSeekConfig(model?: string) {
  loadWorkspaceDotEnv();
  return createLiveConfigFromDefaults(getProviderDefaults("deepseek", model));
}

export function createLiveDeepSeekGateway(testName: string, model?: string) {
  return createGatewayFromConfig(createLiveDeepSeekConfig(model), testName);
}

export function createLiveCerebrasConfig(model?: string) {
  loadWorkspaceDotEnv();
  return createLiveConfigFromDefaults(getProviderDefaults("cerebras", model));
}

export function createLiveCerebrasGateway(testName: string, model?: string) {
  return createGatewayFromConfig(createLiveCerebrasConfig(model), testName);
}

export function createLiveOpenRouterConfig(model?: string) {
  loadWorkspaceDotEnv();
  return createLiveConfigFromDefaults(getProviderDefaults("openrouter", model));
}

export function createLiveOpenRouterGateway(testName: string, model?: string) {
  return createGatewayFromConfig(createLiveOpenRouterConfig(model), testName);
}

export function createLiveCrazyRouterConfig(model?: string) {
  loadWorkspaceDotEnv();
  return createLiveConfigFromDefaults(getProviderDefaults("crazyrouter", model));
}

export function createLiveCrazyRouterGateway(testName: string, model?: string) {
  return createGatewayFromConfig(createLiveCrazyRouterConfig(model), testName);
}

export function createLiveOpenAiConfig(model?: string) {
  loadWorkspaceDotEnv();
  return createLiveConfigFromDefaults(getProviderDefaults("openai", model));
}

export function createLiveOpenAiGateway(testName: string, model?: string) {
  return createGatewayFromConfig(createLiveOpenAiConfig(model), testName);
}

export function createLiveAnthropicConfig(model?: string) {
  loadWorkspaceDotEnv();
  return createLiveConfigFromDefaults(getProviderDefaults("anthropic", model));
}

export function createLiveAnthropicGateway(testName: string, model?: string) {
  return createGatewayFromConfig(createLiveAnthropicConfig(model), testName);
}

export function createLoggedGatewayFromConfig(config: ReturnType<typeof createLiveReaperConfig>, testName: string): ModelGateway {
  return createGatewayFromConfig(config, testName).gateway;
}

function loadWorkspaceDotEnv(): void {
  for (const candidate of [path.resolve(process.cwd(), ".env"), "/workspace/.env"]) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1]!;
      if (process.env[key]) continue;
      process.env[key] = unquoteEnvValue(match[2] ?? "");
    }
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function createLiveConfigFromDefaults(defaults: LiveProviderDefaults) {
  const config = createValidConfig();
  const timeoutMs = Number(process.env.REAPER_LIVE_MODEL_TIMEOUT_MS ?? 300_000);
  const maxRetries = Number(process.env.REAPER_LIVE_MODEL_MAX_RETRIES ?? 2);
  const maxTokens = Number(process.env.REAPER_LIVE_MODEL_MAX_TOKENS ?? defaults.maxTokens);
  const fallbackDefaults = getAvailableFallbackDefaultsChain(defaults.provider);
  const sameProviderFastModel = getSameProviderFastModel(defaults.provider);
  let nextFallbackIndex = 0;

  if (process.env.REAPER_LIVE_LOG_STDOUT === "1") {
    console.log(`[live-gateway] provider=${defaults.provider} model=${defaults.model} timeoutMs=${timeoutMs > 0 ? timeoutMs : "disabled"}`);
  }

  config.models.default_model.provider = defaults.provider;
  config.models.default_model.model = defaults.model;
  if (defaults.apiKeyEnv) {
    config.models.default_model.apiKeyEnv = defaults.apiKeyEnv;
  } else {
    delete config.models.default_model.apiKeyEnv;
  }
  if (defaults.apiBase) {
    config.models.default_model.apiBase = defaults.apiBase;
  } else {
    delete config.models.default_model.apiBase;
  }
  delete config.models.default_model.fallbackProfile;
  config.models.default_model.maxRetries = maxRetries;
  if (timeoutMs > 0) {
    config.models.default_model.timeoutMs = timeoutMs;
  } else {
    delete config.models.default_model.timeoutMs;
  }
  config.models.default_model.defaultParams = {
    ...config.models.default_model.defaultParams,
    maxTokens,
    ...(defaults.provider === "deepseek"
      ? {
          promptCache: {
            enabled: process.env.DEEPSEEK_PROMPT_CACHE !== "0",
            minContentChars: 256,
          },
        }
      : {}),
  };
  config.models.default_model.capabilities = {
    ...config.models.default_model.capabilities,
    streaming: true,
    toolCalling: true,
    jsonMode: true,
    structuredOutput: true,
    embeddings: false,
    maxContextTokens: defaults.maxContextTokens,
    maxOutputTokens: Math.max(maxTokens, defaults.maxTokens),
  };
  if (sameProviderFastModel) {
    config.models.fast_reasoner = makeSameProviderRoleProfile(
      config.models.default_model,
      sameProviderFastModel,
      Number(process.env.REAPER_LIVE_FALLBACK_MODEL_MAX_RETRIES ?? maxRetries),
      maxTokens,
    );
    if (sameProviderFastModel !== config.models.default_model.model) {
      config.models.default_model.fallbackProfile = "fast_reasoner";
    }
  } else if (fallbackDefaults[0]) {
    config.models.default_model.fallbackProfile = "fast_reasoner";
    config.models.fast_reasoner = makeLiveProfileFromDefaults(
      config.models.default_model,
      fallbackDefaults[0],
      timeoutMs,
      Number(process.env.REAPER_LIVE_FALLBACK_MODEL_MAX_RETRIES ?? maxRetries),
      resolveFallbackMaxTokens(fallbackDefaults[0]),
    );
    nextFallbackIndex = 1;
  } else {
    config.models.fast_reasoner = {
      ...config.models.default_model,
      maxRetries: Number(process.env.REAPER_LIVE_FALLBACK_MODEL_MAX_RETRIES ?? maxRetries),
    };
  }
  delete config.models.fast_reasoner.fallbackProfile;

  // `skim_model` and `cheap_router` roles were removed in v0.2.
  // The wiring no longer references them; we keep just the
  // `secondary_model` sibling for OMP #21 promote-context-model.
  // (see src/runtime/context-engineering-wiring.ts modelPromotion)

  if (fallbackDefaults[nextFallbackIndex]) {
    config.models.secondary_model = makeLiveProfileFromDefaults(
      config.models.default_model,
      fallbackDefaults[nextFallbackIndex]!,
      timeoutMs,
      Number(process.env.REAPER_LIVE_FALLBACK_MODEL_MAX_RETRIES ?? maxRetries),
      resolveFallbackMaxTokens(fallbackDefaults[nextFallbackIndex]!),
    );
    nextFallbackIndex += 1;
  } else {
    config.models.secondary_model = {
      ...config.models.fast_reasoner,
    };
  }
  delete config.models.secondary_model.fallbackProfile;

  return config;
}

function getSameProviderFastModel(provider: SupportedLiveProvider): string | undefined {
  const explicit = process.env.REAPER_TBENCH_FAST_MODEL?.trim();
  if (explicit) return explicit;
  if (provider === "deepseek") return getDefaultDeepSeekLatencyFallbackModel();
  return undefined;
}

function makeSameProviderRoleProfile(
  base: ReturnType<typeof createValidConfig>["models"]["default_model"],
  model: string,
  maxRetries: number,
  maxTokens: number,
) {
  const profile = {
    ...base,
    model,
    maxRetries,
    defaultParams: {
      ...base.defaultParams,
      maxTokens,
    },
    capabilities: {
      ...base.capabilities,
      maxOutputTokens: Math.max(maxTokens, base.capabilities.maxOutputTokens ?? maxTokens),
    },
  };
  delete profile.fallbackProfile;
  return profile;
}

function makeLiveProfileFromDefaults(
  base: ReturnType<typeof createValidConfig>["models"]["default_model"],
  defaults: LiveProviderDefaults,
  timeoutMs: number,
  maxRetries: number,
  maxTokens: number,
) {
  const profile = {
    ...base,
    provider: defaults.provider,
    model: defaults.model,
    maxRetries,
    defaultParams: {
      ...base.defaultParams,
      maxTokens,
    },
    capabilities: {
      ...base.capabilities,
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: defaults.maxContextTokens,
      maxOutputTokens: Math.max(maxTokens, defaults.maxTokens),
    },
  };
  if (defaults.apiKeyEnv) {
    profile.apiKeyEnv = defaults.apiKeyEnv;
  } else {
    delete profile.apiKeyEnv;
  }
  if (timeoutMs > 0) {
    profile.timeoutMs = timeoutMs;
  } else {
    delete profile.timeoutMs;
  }
  if (defaults.apiBase) {
    profile.apiBase = defaults.apiBase;
  } else {
    delete profile.apiBase;
  }
  delete profile.fallbackProfile;
  return profile;
}

function getAvailableFallbackDefaultsChain(primaryProvider: SupportedLiveProvider): LiveProviderDefaults[] {
  const rawFallbackProviders = process.env.REAPER_LIVE_FALLBACK_PROVIDERS;
  const rawFallbackProvider = process.env.REAPER_LIVE_FALLBACK_PROVIDER;
  const hasExplicitFallbacks = rawFallbackProviders !== undefined || rawFallbackProvider !== undefined;
  const requested = [
    ...(rawFallbackProviders ?? "").split(","),
    rawFallbackProvider ?? "",
  ]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const defaultOrder: SupportedLiveProvider[] = ["cerebras", "deepseek", "deepinfra", "crazyrouter", "openrouter", "openai", "anthropic"];
  // When REAPER_LIVE_FALLBACK_PROVIDERS is explicitly set to empty, respect it
  // and disable fallbacks rather than falling back to the hardcoded defaultOrder.
  const providers = hasExplicitFallbacks && requested.length === 0
    ? []
    : uniqueProviders([...requested, ...defaultOrder]);
  const fallbacks: LiveProviderDefaults[] = [];

  for (const provider of providers) {
    if (provider === primaryProvider || !isSupportedProvider(provider)) continue;
    const defaults = getProviderDefaults(provider);
    if (!defaults.apiKeyEnv || !process.env[defaults.apiKeyEnv]) continue;
    fallbacks.push(defaults);
    if (fallbacks.length >= 3) break;
  }

  return fallbacks;
}

function uniqueProviders(providers: string[]): SupportedLiveProvider[] {
  const seen = new Set<string>();
  const result: SupportedLiveProvider[] = [];
  for (const provider of providers) {
    if (seen.has(provider) || !isSupportedProvider(provider)) continue;
    seen.add(provider);
    result.push(provider);
  }
  return result;
}

function resolveFallbackMaxTokens(defaults: LiveProviderDefaults): number {
  const configured = Number(process.env.REAPER_LIVE_FALLBACK_MODEL_MAX_TOKENS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  if (defaults.provider === "openrouter" || defaults.provider === "crazyrouter") {
    return Math.min(defaults.maxTokens, 1024);
  }
  return defaults.maxTokens;
}

function createGatewayFromConfig(config: ReturnType<typeof createLiveReaperConfig>, testName: string) {
  const baseGateway = createModelGateway(
    config,
    new ProviderMultiplexerClient({
      onAttempt: (event) =>
        writeLiveLlmLog({
          testName,
          operation: event.operation === "stream" ? "stream_attempt" : event.operation === "embed" ? "embed_attempt" : "generate_attempt",
          provider: event.provider,
          model: event.model,
          role: event.role,
          request: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            retrying: event.retrying,
          },
          response: {
            ok: event.ok,
            durationMs: event.durationMs,
            ...(event.status !== undefined ? { status: event.status } : {}),
            ...(event.error ? { error: event.error } : {}),
            profileName: event.profileName,
          },
          timestamp: new Date().toISOString(),
        }),
    }),
  );

  const gateway = new ResilientModelGateway(baseGateway, {
    onAttempt: (event) =>
      writeLiveLlmLog({
        testName,
        operation: "retry_attempt",
        provider: event.provider,
        model: event.model,
        role: event.role,
        request: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retrying: event.retrying,
          ...(event.kind !== undefined ? { kind: event.kind } : {}),
          ...(event.fallbackTriggered !== undefined ? { fallbackTriggered: event.fallbackTriggered } : {}),
        },
        response: {
          ok: event.ok,
          durationMs: event.durationMs,
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
          profileName: event.profileName,
        },
        timestamp: new Date().toISOString(),
      }),
  });

  return {
    config,
    gateway: wrapGatewayWithLogging(gateway, testName),
  };
}

function getLiveProvider(): SupportedLiveProvider {
  const raw = (
    process.env.REAPER_TBENCH_PROVIDER ??
    process.env.REAPER_EVAL_PROVIDER ??
    process.env.REAPER_LIVE_PROVIDER ??
    process.env.REAPER_MODEL_PROVIDER ??
    "deepseek"
  ).trim().toLowerCase();
  if (isSupportedProvider(raw)) return raw;
  throw new Error(
    `Unsupported REAPER_LIVE_PROVIDER '${raw}'. Supported providers: deepinfra, deepseek, cerebras, openrouter, crazyrouter, openai, anthropic, minimax, minimax-oauth, mimo, nuralwatt, nuralwatt2, azure`,
  );
}

function getProviderDefaults(provider: string, model?: string): LiveProviderDefaults {
  if (!isSupportedProvider(provider)) {
    throw new Error(
      `Unsupported provider '${provider}'. Supported providers: deepinfra, deepseek, cerebras, openrouter, crazyrouter, openai, anthropic, minimax, minimax-oauth, mimo, nuralwatt, nuralwatt2, azure`,
    );
  }

  switch (provider) {
    case "deepinfra":
      return {
        provider,
        model: model ?? getDefaultDeepInfraModel(),
        apiKeyEnv: getFirstConfiguredEnvName(["DEEPINFRA_API_KEY", "DEEP_INFRA_API_KEY", "DEEPINFRA_PROVIDER_KEY"]) ?? "DEEPINFRA_API_KEY",
        maxContextTokens: 131000,
        maxTokens: 32768,
      };
    case "cerebras":
      return {
        provider,
        model: model ?? getDefaultCerebrasModel(),
        apiKeyEnv: "CEREBRAS_PROVIDER_KEY",
        maxContextTokens: 131000,
        maxTokens: 8192,
      };
    case "deepseek":
      return {
        provider,
        model: model ?? getDefaultDeepSeekModel(),
        apiKeyEnv: "DEEPSEEK_API_KEY",
        maxContextTokens: 1_000_000,
        maxTokens: 32768,
      };
    case "openrouter":
      return {
        provider,
        model: model ?? getDefaultOpenRouterModel(),
        apiKeyEnv: "OPENROUTER_API_KEY",
        maxContextTokens: 128000,
        maxTokens: 16000,
      };
    case "crazyrouter":
      return {
        provider,
        model: model ?? getDefaultCrazyRouterModel(),
        apiKeyEnv: getFirstConfiguredEnvName(["CRAZY_ROUTER_API_KEY", "CRAZYROUTER_API_KEY", "CRAZY_ROUTER_PROVIDER"]) ?? "CRAZY_ROUTER_API_KEY",
        maxContextTokens: 128000,
        maxTokens: 16000,
      };
    case "minimax":
      return {
        provider,
        model: model ?? getDefaultMimoModel(),
        apiKeyEnv: "MINIMAX_API_KEY",
        apiBase: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
        maxContextTokens: 128000,
        maxTokens: 32768,
      };
    case "minimax-oauth":
      return {
        provider,
        model: model ?? "MiniMax-M3",
        apiKeyEnv: "MINIMAX_OAUTH_TOKEN",
        apiBase: process.env.MINIMAX_OAUTH_BASE_URL ?? "https://api.minimax.io/anthropic",
        maxContextTokens: 128000,
        maxTokens: 4096,
      };
    case "mimo":
      return {
        provider,
        model: model ?? getDefaultMimoModel(),
        apiKeyEnv: "MIMO_API_PROVIDER",
        apiBase: process.env.MIMO_BASE_OPENAI_URL ?? "https://token-plan-sgp.xiaomimimo.com/v1",
        maxContextTokens: 128000,
        maxTokens: 32768,
      };
    case "nuralwatt":
      return {
        provider,
        model: model ?? getDefaultNuralWattModel(),
        apiKeyEnv: "NURALWATT_API_KEY",
        apiBase: process.env.NURALWATT_BASE_URL ?? "https://api.neuralwatt.com/v1",
        maxContextTokens: 262128,
        maxTokens: 32000,
      };
    case "nuralwatt2":
      return {
        provider,
        model: model ?? getDefaultNuralWattModel(),
        apiKeyEnv: "NURALWATT_API_KEY2",
        apiBase: process.env.NURALWATT_BASE_URL ?? "https://api.neuralwatt.com/v1",
        maxContextTokens: 262128,
        maxTokens: 32000,
      };
    case "azure":
      return {
        provider,
        model: model ?? getDefaultAzureOpenAiModel(),
        apiKeyEnv: "AZURE_OPENAI_API_KEY",
        apiBase: process.env.AZURE_OPENAI_BASE_URL ?? "",
        maxContextTokens: 128000,
        maxTokens: 16000,
      };
    case "openai":
      return {
        provider,
        model: model ?? getDefaultOpenAiModel(),
        apiKeyEnv: "OPENAI_API_KEY",
        maxContextTokens: 400000,
        maxTokens: 32000,
      };
    case "anthropic":
      return {
        provider,
        model: model ?? getDefaultAnthropicModel(),
        apiKeyEnv: "ANTHROPIC_API_KEY",
        maxContextTokens: 200000,
        maxTokens: 32000,
      };
  }
}

function getFirstConfiguredEnvName(names: string[]): string | undefined {
  return names.find((name) => Boolean(process.env[name]));
}

function isSupportedProvider(provider: string): provider is SupportedLiveProvider {
  return (
    provider === "deepinfra" ||
    provider === "deepseek" ||
    provider === "cerebras" ||
    provider === "openrouter" ||
    provider === "crazyrouter" ||
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "minimax" ||
    provider === "minimax-oauth" ||
    provider === "mimo" ||
    provider === "nuralwatt" ||
    provider === "nuralwatt2" ||
    provider === "azure"
  );
}

function createModelGateway(
  config: ReturnType<typeof createLiveReaperConfig>,
  client: ProviderMultiplexerClient,
): ModelGateway {
  return new ConfiguredModelGateway(config, client);
}

function wrapGatewayWithLogging(gateway: ModelGateway, testName: string): ModelGateway {
  return {
    resolveRole(role) {
      return gateway.resolveRole(role);
    },
    async generate(request) {
      const result = await gateway.generate(request);
      const requestSummary = buildLiveRequestSummary(request);
      await writeLiveLlmLog({
        testName,
        operation: "generate",
        provider: result.provider,
        model: result.model,
        role: request.role,
        request: requestSummary,
        response: {
          content: result.content,
          ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
          finishReason: result.finishReason ?? null,
          profileName: result.profileName,
        },
        timestamp: new Date().toISOString(),
      });
      if (process.env.REAPER_LIVE_LOG_STDOUT === "1") {
        console.log(
          JSON.stringify({
            event: "live_llm_generate",
            testName,
            provider: result.provider,
            model: result.model,
            role: request.role,
            finishReason: result.finishReason ?? null,
            contentPreview: result.content.slice(0, 200),
          }),
        );
      }
      return result;
    },
    async *stream(request) {
      const profile = await gateway.resolveRole(request.role);
      const eventTypes: string[] = [];
      let combinedContent = "";
      let reasoningContent = "";

      for await (const event of gateway.stream(request)) {
        eventTypes.push(event.type);
        if (event.type === "reasoning_delta" && event.content) reasoningContent += event.content;
        if (event.type === "message_delta" && event.content) combinedContent += event.content;
        yield event;
      }

      const requestSummary = buildLiveRequestSummary(request);

      await writeLiveLlmLog({
        testName,
        operation: "stream",
        provider: profile.provider,
        model: profile.model,
        role: request.role,
        request: requestSummary,
        response: {
          eventTypes,
          combinedContent,
          ...(reasoningContent ? { reasoningContent } : {}),
          profileName: profile.profileName,
        },
        timestamp: new Date().toISOString(),
      });
    },
    embed(request) {
      return gateway.embed(request);
    },
    countTokens(request) {
      return gateway.countTokens(request);
    },
    dispose() {
      return gateway.dispose?.() ?? Promise.resolve();
    },
  };
}

function buildLiveRequestSummary(request: Parameters<ModelGateway["generate"]>[0]): {
  messageCount: number;
  responseFormat?: string;
  maxTokens?: number;
  promptPreview?: string;
  promptTail?: string;
  promptChars?: number;
  promptContainsCommandLedger?: boolean;
  promptContainsRecentToolResults?: boolean;
  promptContainsExecutionResult?: boolean;
} {
  const prompt = request.messages.at(-1)?.content ?? "";
  return {
    messageCount: request.messages.length,
    ...(request.responseFormat !== undefined ? { responseFormat: request.responseFormat } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(prompt ? { promptPreview: prompt.slice(0, 200) } : {}),
    ...(prompt ? { promptTail: prompt.slice(-4000) } : {}),
    ...(prompt ? { promptChars: prompt.length } : {}),
    ...(prompt ? { promptContainsCommandLedger: prompt.includes("Recent command ledger:") } : {}),
    ...(prompt ? { promptContainsRecentToolResults: prompt.includes("Recent tool results:") || prompt.includes("Recent observations:") } : {}),
    ...(prompt ? { promptContainsExecutionResult: /EXECUTION RESULT|stdout:|stderr:|exitCode|exit=/i.test(prompt) } : {}),
  };
}
