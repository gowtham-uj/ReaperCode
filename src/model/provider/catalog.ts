import type {
  ProviderDescriptor,
  ProviderIntegration,
  ProviderModelDescriptor,
  SdkFamilyId,
} from "./types.js";
import {
  getModelsDevCatalog,
  type ModelsDevCatalogService,
} from "./models-dev-catalog.js";
import type {
  ModelsDevModel,
  ModelsDevProvider,
} from "./models-dev-types.js";
import { specializeProviderIntegration } from "./auth-integrations.js";

const catalog = getModelsDevCatalog();

/** Current provider integrations derived from the pinned/refreshed Models.dev catalog. */
export function listProviderIntegrations(
  source: ModelsDevCatalogService = catalog,
  includeModelDetails = true,
): ProviderIntegration[] {
  return source.providers().map((provider) => toIntegration(provider, source, includeModelDetails));
}

/** Backward-compatible startup snapshot for CLI callers. */
export const PROVIDER_INTEGRATIONS: ProviderIntegration[] = listProviderIntegrations(catalog, false);
export const PROVIDER_CATALOG: ProviderDescriptor[] =
  PROVIDER_INTEGRATIONS.map((integration) => integration.descriptor);

export function providerIntegrationFor(
  id: string,
  source: ModelsDevCatalogService = catalog,
  includeModelDetails = true,
): ProviderIntegration | undefined {
  const provider = source.provider(id);
  return provider ? toIntegration(provider, source, includeModelDetails) : undefined;
}

export function findProviderDescriptor(id: string): ProviderDescriptor | undefined {
  return providerIntegrationFor(id)?.descriptor;
}

export function modelsDevCatalog(): ModelsDevCatalogService {
  return catalog;
}

function toIntegration(
  provider: ModelsDevProvider,
  source: ModelsDevCatalogService,
  includeModelDetails: boolean,
): ProviderIntegration {
  return specializeProviderIntegration({
    descriptor: toDescriptor(provider, source, includeModelDetails),
    authMethods: [{ id: "api-key", type: "api", label: "API key" }],
  });
}

function toDescriptor(
  provider: ModelsDevProvider,
  source: ModelsDevCatalogService,
  includeModelDetails: boolean,
): ProviderDescriptor {
  const models = Object.values(provider.models);
  const defaultModel = source.defaultModel(provider.id)?.id ?? models[0]?.id ?? "";
  const modelDetails = includeModelDetails
    ? Object.fromEntries(models.map((model) => [model.id, toModelDescriptor(provider, model)]))
    : undefined;
  const maxContextTokens = maximum(models.map((model) => model.limit.context));
  const maxOutputTokens = maximum(models.map((model) => model.limit.output));
  const inputModalities = new Set(models.flatMap((model) => model.modalities?.input ?? ["text"]));
  return {
    id: provider.id,
    label: provider.name,
    sdkFamily: sdkFamily(provider.npm),
    baseUrl: provider.api ?? "",
    envVar: provider.env[0] ?? "",
    envVars: provider.env,
    ...(provider.npm ? { npm: provider.npm } : {}),
    ...(provider.api ? { api: provider.api } : {}),
    ...(provider.doc ? { doc: provider.doc } : {}),
    keyHint: provider.doc ? `Provider documentation: ${provider.doc}` : `API key for ${provider.name}`,
    defaultModel,
    models: models.map((model) => model.id),
    ...(modelDetails ? { modelDetails } : {}),
    capabilities: {
      streaming: true,
      toolCalling: models.some((model) => model.tool_call),
      jsonMode: models.some((model) => model.structured_output === true),
      structuredOutput: models.some((model) => model.structured_output === true),
      embeddings: false,
      imageInput: inputModalities.has("image"),
      videoInput: inputModalities.has("video"),
      ...(maxContextTokens ? { maxContextTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    },
    supportsReasoning: models.some((model) => model.reasoning),
    authScheme: provider.npm === "@ai-sdk/anthropic" ? "x-api-key" : "bearer",
  };
}

function toModelDescriptor(
  provider: ModelsDevProvider,
  model: ModelsDevModel,
): ProviderModelDescriptor {
  const npm = model.provider?.npm ?? provider.npm;
  const api = model.provider?.api ?? provider.api;
  return {
    id: model.id,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(model.family ? { family: model.family } : {}),
    status: model.status ?? "active",
    releaseDate: model.release_date,
    ...(model.last_updated ? { lastUpdated: model.last_updated } : {}),
    contextTokens: model.limit.context,
    ...(model.limit.input ? { inputTokens: model.limit.input } : {}),
    outputTokens: model.limit.output,
    supportsReasoning: model.reasoning,
    ...(model.reasoning_options ? { reasoningOptions: model.reasoning_options } : {}),
    supportsAttachments: model.attachment,
    supportsToolCalls: model.tool_call,
    supportsTemperature: model.temperature,
    supportsStructuredOutput: model.structured_output ?? false,
    ...(model.modalities ? { modalities: model.modalities } : {}),
    ...(model.cost ? { cost: model.cost } : {}),
    ...(npm ? { npm } : {}),
    ...(api ? { api } : {}),
  };
}

function sdkFamily(npm: string | undefined): SdkFamilyId {
  if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
  if (
    npm === "@ai-sdk/openai-compatible"
    || npm === "@ai-sdk/openai"
    || npm === "@ai-sdk/azure"
    || npm === "@ai-sdk/deepinfra"
    || npm === "@ai-sdk/groq"
    || npm === "@ai-sdk/perplexity"
    || npm === "@ai-sdk/togetherai"
    || npm === "@ai-sdk/xai"
    || npm === "@openrouter/ai-sdk-provider"
  ) {
    return "openai-chat";
  }
  return "custom";
}

function maximum(values: number[]): number | undefined {
  return values.length ? Math.max(...values) : undefined;
}
