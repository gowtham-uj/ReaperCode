/**
 * Transport loaders for every npm identity advertised by the Models.dev
 * catalog snapshot.
 *
 * A "transport" is the AI SDK provider factory that turns per-call
 * credentials and options into a `LanguageModelV3`. The catalog names the
 * transport by npm package (`provider.npm`, or a per-model
 * `model.provider.npm` override); this module maps that name to a lazily
 * imported factory so a Reaper build only pays for the packages a user
 * actually reaches.
 *
 * Loaders are intentionally data-driven: nothing here knows a provider id.
 * Provider-specific option shaping lives in `transport-options.ts`.
 */

export type TransportFactory = (options: Record<string, unknown>) => TransportSdk;

export interface TransportSdk {
  languageModel(modelId: string): unknown;
  chat?: (modelId: string) => unknown;
  responses?: (modelId: string) => unknown;
  textEmbeddingModel?: (modelId: string) => unknown;
}

type TransportLoader = () => Promise<TransportFactory>;

/**
 * npm identity → AI SDK factory. Keys must match the catalog's `npm`
 * strings exactly, including subpath entries such as
 * `@ai-sdk/google-vertex/anthropic`.
 */
const TRANSPORT_LOADERS: Record<string, TransportLoader> = {
  "@ai-sdk/amazon-bedrock": () =>
    import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock as unknown as TransportFactory),
  "@ai-sdk/amazon-bedrock/mantle": () =>
    import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle as unknown as TransportFactory),
  "@ai-sdk/anthropic": () =>
    import("@ai-sdk/anthropic").then((m) => m.createAnthropic as unknown as TransportFactory),
  "@ai-sdk/azure": () =>
    import("@ai-sdk/azure").then((m) => m.createAzure as unknown as TransportFactory),
  "@ai-sdk/cohere": () =>
    import("@ai-sdk/cohere").then((m) => m.createCohere as unknown as TransportFactory),
  "@ai-sdk/deepinfra": () =>
    import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra as unknown as TransportFactory),
  "@ai-sdk/gateway": () =>
    import("@ai-sdk/gateway").then((m) => m.createGateway as unknown as TransportFactory),
  "@ai-sdk/google": () =>
    import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI as unknown as TransportFactory),
  "@ai-sdk/google-vertex": () =>
    import("@ai-sdk/google-vertex").then((m) => m.createVertex as unknown as TransportFactory),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic as unknown as TransportFactory),
  "@ai-sdk/groq": () =>
    import("@ai-sdk/groq").then((m) => m.createGroq as unknown as TransportFactory),
  "@ai-sdk/mistral": () =>
    import("@ai-sdk/mistral").then((m) => m.createMistral as unknown as TransportFactory),
  "@ai-sdk/openai": () =>
    import("@ai-sdk/openai").then((m) => m.createOpenAI as unknown as TransportFactory),
  "@ai-sdk/openai-compatible": () =>
    import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible as unknown as TransportFactory),
  "@ai-sdk/perplexity": () =>
    import("@ai-sdk/perplexity").then((m) => m.createPerplexity as unknown as TransportFactory),
  "@ai-sdk/togetherai": () =>
    import("@ai-sdk/togetherai").then((m) => m.createTogetherAI as unknown as TransportFactory),
  "@ai-sdk/vercel": () =>
    import("@ai-sdk/vercel").then((m) => m.createVercel as unknown as TransportFactory),
  "@ai-sdk/xai": () =>
    import("@ai-sdk/xai").then((m) => m.createXai as unknown as TransportFactory),
  "@aihubmix/ai-sdk-provider": () =>
    import("@aihubmix/ai-sdk-provider").then((m) => pickFactory(m, ["createAiHubMix", "createAihubmix"])),
  "@jerome-benoit/sap-ai-provider-v2": () =>
    import("@jerome-benoit/sap-ai-provider-v2").then((m) => pickFactory(m, ["createSAPAIProvider", "createSapAi"])),
  "@openrouter/ai-sdk-provider": () =>
    import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter as unknown as TransportFactory),
  "@qvac/ai-sdk-provider": () =>
    import("@qvac/ai-sdk-provider").then((m) => pickFactory(m, ["createQvac", "createQVAC"])),
  "@saladtechnologies-oss/ai-sdk-provider": () =>
    import("@saladtechnologies-oss/ai-sdk-provider").then((m) => pickFactory(m, ["createSaladCloud", "createSalad"])),
  "ai-gateway-provider": () =>
    import("ai-gateway-provider").then((m) => pickFactory(m, ["createAiGateway"])),
  "gitlab-ai-provider": () =>
    import("gitlab-ai-provider").then((m) => pickFactory(m, ["createGitLab"])),
  "merge-gateway-ai-sdk-provider": () =>
    import("merge-gateway-ai-sdk-provider").then((m) => pickFactory(m, ["createMergeGateway", "createMerge"])),
  "venice-ai-sdk-provider": () =>
    import("venice-ai-sdk-provider").then((m) => pickFactory(m, ["createVenice"])),
  "watsonx-ai-provider": () =>
    import("watsonx-ai-provider").then((m) => pickFactory(m, ["createWatsonx", "createWatsonX"])),
};

const factoryCache = new Map<string, Promise<TransportFactory>>();

/** Every npm identity this build can serve. */
export function supportedTransports(): string[] {
  return Object.keys(TRANSPORT_LOADERS).sort();
}

export function hasTransport(npm: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRANSPORT_LOADERS, npm);
}

/**
 * Providers whose catalog entry names no npm package.
 *
 * They speak the OpenAI chat-completions wire format against their own base
 * URL, so `@ai-sdk/openai-compatible` — already in the loader table — is the
 * right transport rather than a missing one.
 */
export const OPENAI_COMPATIBLE_TRANSPORT = "@ai-sdk/openai-compatible";

/**
 * The npm identity a provider/model pair actually runs on.
 *
 * A model may override its provider's transport (`model.provider?.npm`), and a
 * provider with no package falls back to OpenAI-compatible. This is the single
 * rule for "which loader does this model need"; the transport client, the
 * Settings surface, and the coverage tests all read it from here so they
 * cannot disagree about what is runnable.
 */
export function effectiveTransportNpm(input: {
  providerNpm?: string | undefined;
  modelNpm?: string | undefined;
}): string {
  return input.modelNpm ?? input.providerNpm ?? OPENAI_COMPATIBLE_TRANSPORT;
}

/**
 * Whether a provider/model pair can be served by an installed loader.
 *
 * A catalog refresh can introduce a transport this build has no package for.
 * Those models must not be advertised as runnable: the failure would otherwise
 * surface as a turn that starts and then dies importing a missing module.
 */
export function isTransportInstalled(input: {
  providerNpm?: string | undefined;
  modelNpm?: string | undefined;
}): boolean {
  return hasTransport(effectiveTransportNpm(input));
}

/**
 * Resolve the AI SDK factory for an npm identity. Results are cached so
 * repeated turns on the same provider do not re-import the package.
 */
export function loadTransport(npm: string): Promise<TransportFactory> {
  const cached = factoryCache.get(npm);
  if (cached) return cached;
  const loader = TRANSPORT_LOADERS[npm];
  if (!loader) {
    return Promise.reject(new Error(`No transport is installed for "${npm}"`));
  }
  const promise = loader().catch((error: unknown) => {
    factoryCache.delete(npm);
    throw new Error(`Could not load the "${npm}" transport`, { cause: error });
  });
  factoryCache.set(npm, promise);
  return promise;
}

export function _resetTransportCacheForTests(): void {
  factoryCache.clear();
}

function pickFactory(module: Record<string, unknown>, names: string[]): TransportFactory {
  for (const name of names) {
    const candidate = module[name];
    if (typeof candidate === "function") return candidate as TransportFactory;
  }
  const fallback = Object.entries(module).find(
    ([key, value]) => key.startsWith("create") && typeof value === "function",
  );
  if (fallback) return fallback[1] as TransportFactory;
  throw new Error(`The transport package exports no factory (looked for ${names.join(", ")})`);
}
