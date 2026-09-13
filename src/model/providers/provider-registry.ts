import type { ResolvedModelProfile } from "../types.js";
import { getModelsDevCatalog } from "../provider/models-dev-catalog.js";

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
  minimax: {
    apiBase: "https://api.minimax.io/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  nuralwatt: {
    apiBase: "https://api.neuralwatt.com/v1",
    authHeader: "authorization",
    pathStyle: "openai",
    modelTransform: (model) => model,
  },
  nuralwatt2: {
    apiBase: "https://api.neuralwatt.com/v1",
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

  // The catalog is the authority for any provider we did not hard-code.
  // Silently pointing an unknown provider at a local LiteLLM proxy sent
  // real credentials to 127.0.0.1:4000 for anyone who typed a provider id
  // slightly wrong, so catalog resolution comes first and a miss is an error.
  const catalog = getModelsDevCatalog();
  const catalogBase = catalog.model(providerKey, profile.model)?.provider?.api
    ?? catalog.provider(providerKey)?.api;
  if (catalogBase) {
    return {
      apiBase: catalogBase,
      authHeader: "authorization",
      pathStyle: "openai",
      modelTransform: (model) => model,
    };
  }

  if (providerKey === "litellm" || providerKey.startsWith("litellm-")) {
    return liteLlmProxyDefaults;
  }

  throw new Error(
    `Provider "${profile.provider}" has no API base URL. Set one on the model profile `
    + `or pick a provider from the catalog.`,
  );
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
