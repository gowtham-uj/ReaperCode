import type { ResolvedModelProfile } from "../types.js";

interface ProviderDefaults {
  apiBase: string;
  authHeader: "authorization" | "api-key";
  pathStyle: "openai" | "azure-openai";
  modelTransform: (model: string, provider: string) => string;
}

const providerDefaults: Record<string, ProviderDefaults> = {
  litellm: {
    apiBase: "http://127.0.0.1:4000",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  deepinfra: {
    apiBase: "https://api.deepinfra.com/v1/openai",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  openai: {
    apiBase: "https://api.openai.com/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  openrouter: {
    apiBase: "https://openrouter.ai/api/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  crazyrouter: {
    apiBase: "https://crazyrouter.com/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => resolveCrazyRouterModelName(model),
  },
  anthropic: {
    apiBase: "https://api.anthropic.com/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  deepseek: {
    apiBase: "https://api.deepseek.com",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  cerebras: {
    apiBase: "https://api.cerebras.ai/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  zai: {
    apiBase: "https://api.z.ai/api/paas/v4",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  azure: {
    apiBase: process.env.AZURE_OPENAI_BASE_URL ?? "",
    authHeader: "api-key",
    pathStyle: "azure-openai",
    modelTransform: (model) => model,
  },
};

function resolveCrazyRouterModelName(model: string): string {
  const normalized = model.trim();
  if (normalized === "Qwen/Qwen3.6-35B-A3B") {
    return "qwen3.6-plus";
  }
  return normalized;
}

const liteLlmProxyDefaults: ProviderDefaults = {
  apiBase: "http://127.0.0.1:4000",
  authHeader: "authorization",
  pathStyle: "openai",
  modelTransform: (model, provider) => `${provider}/${model}`,
};

export function resolveProviderDefaults(profile: ResolvedModelProfile): ProviderDefaults {
  const providerKey = profile.provider.trim().toLowerCase();
  const defaults = providerDefaults[providerKey];
  if (defaults) return defaults;

  if (profile.apiBase) {
    return {
      apiBase: profile.apiBase,
      authHeader: "authorization",
      pathStyle: "openai",
      modelTransform: (model) => model,
    };
  }

  return liteLlmProxyDefaults;
}

export function resolveProviderBaseUrl(profile: ResolvedModelProfile): string {
  return profile.apiBase ?? resolveProviderDefaults(profile).apiBase;
}

export function resolveProviderModelName(profile: ResolvedModelProfile): string {
  const defaults = resolveProviderDefaults(profile);
  return defaults.modelTransform(profile.model, profile.provider.trim().toLowerCase());
}

export function usesAzureOpenAiV1(profile: ResolvedModelProfile): boolean {
  if (resolveProviderDefaults(profile).pathStyle !== "azure-openai") {
    return false;
  }
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim().toLowerCase();
  const base = resolveProviderBaseUrl(profile).replace(/\/+$/, "").toLowerCase();
  return apiVersion === "v1" || base.endsWith("/openai/v1");
}
