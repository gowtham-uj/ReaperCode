/**
 * Per-provider option shaping and model selection for the AI SDK transports.
 *
 * `transports.ts` answers "which factory serves this npm identity"; this
 * module answers "what options does that factory need for this provider, and
 * which of the SDK's model entry points should the call use". Keeping the two
 * apart means adding a provider quirk never touches the loader table.
 *
 * Credentials arrive per call. Nothing here reads or writes `process.env`
 * beyond reading catalog-declared variables as a fallback, so two threads on
 * different providers cannot race each other's keys.
 */

import type { TransportSdk } from "./transports.js";

export interface TransportResolution {
  /** npm identity to load. */
  npm: string;
  /** Options handed to the AI SDK factory. */
  options: Record<string, unknown>;
  /** Chooses the concrete language model from a constructed SDK. */
  selectModel: (sdk: TransportSdk, modelId: string) => unknown;
}

export interface TransportContext {
  providerId: string;
  modelId: string;
  /** npm identity from the catalog (model override already applied). */
  npm: string;
  /** Catalog `api` base URL, when the provider declares one. */
  apiBase?: string;
  /** Per-call API key or OAuth access token. Never a process-global. */
  apiKey?: string;
  /** Non-secret auth metadata (resource name, account id, region, project). */
  metadata?: Record<string, string>;
  /** Catalog-declared environment variable names for this provider. */
  envVars?: string[];
  /** Environment used for fallbacks. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Extra provider options from user config. */
  extraOptions?: Record<string, unknown>;
}

const REFERER = "https://github.com/reaper";

/**
 * Build the factory options and model selector for one call.
 */
export function resolveTransport(context: TransportContext): TransportResolution {
  const env = context.env ?? process.env;
  const options: Record<string, unknown> = { ...context.extraOptions };
  if (context.apiKey) options.apiKey = context.apiKey;
  if (context.apiBase) options.baseURL = context.apiBase;

  let selectModel = defaultSelect;

  switch (context.providerId) {
    case "openai":
    case "meta":
      // OpenAI-family reasoning models expose their full tool/reasoning
      // surface only on the Responses API.
      selectModel = responsesFirst;
      break;

    case "xai":
      selectModel = responsesFirst;
      break;

    case "anthropic":
      options.headers = {
        ...asHeaders(options.headers),
        "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      };
      break;

    case "github-copilot":
      options.headers = {
        ...asHeaders(options.headers),
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.99.0",
      };
      selectModel = copilotSelect;
      break;

    case "azure":
    case "azure-cognitive-services": {
      const resource = firstNonEmpty([
        context.metadata?.resourceName,
        context.metadata?.accountId,
        env.AZURE_RESOURCE_NAME,
      ]);
      if (resource) options.resourceName = resource;
      if (!resource && !options.baseURL) {
        throw new Error(
          "Azure needs a resource name. Reconnect the provider and supply one, or set AZURE_RESOURCE_NAME.",
        );
      }
      selectModel = azureSelect;
      break;
    }

    case "amazon-bedrock": {
      const region = firstNonEmpty([context.metadata?.region, env.AWS_REGION]) ?? "us-east-1";
      options.region = region;
      delete options.baseURL;
      selectModel = context.npm === "@ai-sdk/amazon-bedrock/mantle"
        ? bedrockMantleSelect
        : (sdk, modelId) => sdk.languageModel(bedrockRegionPrefix(modelId, region));
      break;
    }

    case "google-vertex": {
      const project = firstNonEmpty([
        context.metadata?.project,
        env.GOOGLE_VERTEX_PROJECT,
        env.GOOGLE_CLOUD_PROJECT,
        env.GCP_PROJECT,
      ]);
      const location = firstNonEmpty([
        context.metadata?.location,
        env.GOOGLE_VERTEX_LOCATION,
        env.GOOGLE_CLOUD_LOCATION,
      ]) ?? "us-central1";
      if (!project) throw new Error("Vertex AI needs a project. Set GOOGLE_VERTEX_PROJECT.");
      options.project = project;
      options.location = location;
      delete options.apiKey;
      delete options.baseURL;
      break;
    }

    case "google-vertex-anthropic": {
      const project = firstNonEmpty([
        context.metadata?.project,
        env.GOOGLE_VERTEX_PROJECT,
        env.GOOGLE_CLOUD_PROJECT,
      ]);
      const location = firstNonEmpty([
        context.metadata?.location,
        env.GOOGLE_VERTEX_LOCATION,
        env.GOOGLE_CLOUD_LOCATION,
      ]) ?? "global";
      if (!project) throw new Error("Vertex Anthropic needs a project. Set GOOGLE_VERTEX_PROJECT.");
      options.project = project;
      options.location = location;
      delete options.apiKey;
      break;
    }

    case "cloudflare-workers-ai": {
      const accountId = firstNonEmpty([context.metadata?.accountId, env.CLOUDFLARE_ACCOUNT_ID]);
      if (!accountId) throw new Error("Cloudflare Workers AI needs an account id.");
      options.baseURL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
      break;
    }

    case "cloudflare-ai-gateway": {
      const accountId = firstNonEmpty([context.metadata?.accountId, env.CLOUDFLARE_ACCOUNT_ID]);
      const gatewayId = firstNonEmpty([context.metadata?.gatewayId, env.CLOUDFLARE_GATEWAY_ID]);
      if (!accountId || !gatewayId) {
        throw new Error("Cloudflare AI Gateway needs both an account id and a gateway id.");
      }
      options.accountId = accountId;
      options.gateway = gatewayId;
      break;
    }

    case "gitlab": {
      const instanceUrl = firstNonEmpty([context.metadata?.instanceUrl, env.GITLAB_INSTANCE_URL])
        ?? "https://gitlab.com";
      options.baseURL = `${instanceUrl.replace(/\/+$/, "")}/api/v4`;
      break;
    }

    case "snowflake-cortex": {
      const account = firstNonEmpty([context.metadata?.account, env.SNOWFLAKE_ACCOUNT]);
      if (!account) throw new Error("Snowflake Cortex needs an account identifier.");
      options.baseURL = `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`;
      break;
    }

    case "sap-ai-core":
      selectModel = (sdk, modelId) =>
        typeof sdk === "function" ? (sdk as (id: string) => unknown)(modelId) : sdk.languageModel(modelId);
      break;

    case "openrouter":
    case "llmgateway":
    case "zenmux":
    case "nvidia":
      options.headers = {
        ...asHeaders(options.headers),
        "HTTP-Referer": REFERER,
        "X-Title": "reaper",
      };
      break;

    default:
      break;
  }

  // Every OpenAI-compatible provider needs an explicit base URL and a name;
  // the generic factory has no per-provider defaults to fall back on.
  if (context.npm === "@ai-sdk/openai-compatible") {
    options.name ??= context.providerId;
    if (!options.baseURL) {
      throw new Error(`Provider "${context.providerId}" has no API base URL in the catalog.`);
    }
  }

  if (!options.apiKey && context.envVars?.length) {
    for (const name of context.envVars) {
      const value = env[name]?.trim();
      if (value) {
        options.apiKey = value;
        break;
      }
    }
  }

  return { npm: context.npm, options, selectModel };
}

function defaultSelect(sdk: TransportSdk, modelId: string): unknown {
  return sdk.languageModel(modelId);
}

function responsesFirst(sdk: TransportSdk, modelId: string): unknown {
  return sdk.responses ? sdk.responses(modelId) : sdk.languageModel(modelId);
}

function azureSelect(sdk: TransportSdk, modelId: string): unknown {
  if (sdk.responses) return sdk.responses(modelId);
  if (sdk.chat) return sdk.chat(modelId);
  return sdk.languageModel(modelId);
}

function copilotSelect(sdk: TransportSdk, modelId: string): unknown {
  if (!sdk.responses && !sdk.chat) return sdk.languageModel(modelId);
  const match = /^gpt-(\d+)/.exec(modelId);
  if (sdk.responses && match && Number(match[1]) >= 5 && !modelId.startsWith("gpt-5-mini")) {
    return sdk.responses(modelId);
  }
  return sdk.chat ? sdk.chat(modelId) : sdk.languageModel(modelId);
}

function bedrockMantleSelect(sdk: TransportSdk, modelId: string): unknown {
  if (modelId === "openai.gpt-oss-safeguard-20b" || modelId === "openai.gpt-oss-safeguard-120b") {
    return sdk.chat?.(modelId) ?? sdk.languageModel(modelId);
  }
  return sdk.responses?.(modelId) ?? sdk.languageModel(modelId);
}

/**
 * Bedrock cross-region inference profiles. Models already carrying a region
 * prefix are passed through untouched.
 */
function bedrockRegionPrefix(modelId: string, region: string): string {
  const existing = ["global.", "us.", "eu.", "jp.", "apac.", "au."];
  if (existing.some((prefix) => modelId.startsWith(prefix))) return modelId;
  const family = region.split("-")[0];

  if (family === "us") {
    const needs = ["nova-micro", "nova-lite", "nova-pro", "nova-premier", "nova-2", "claude", "deepseek"];
    if (needs.some((part) => modelId.includes(part)) && !region.startsWith("us-gov")) {
      return `us.${modelId}`;
    }
    return modelId;
  }

  if (family === "eu") {
    const regions = ["eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-central-1", "eu-south-1", "eu-south-2"];
    const needs = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"];
    if (regions.includes(region) && needs.some((part) => modelId.includes(part))) return `eu.${modelId}`;
    return modelId;
  }

  if (family === "ap") {
    if (["ap-southeast-2", "ap-southeast-4"].includes(region)
      && ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((part) => modelId.includes(part))) {
      return `au.${modelId}`;
    }
    const needs = ["claude", "nova-lite", "nova-micro", "nova-pro"];
    if (!needs.some((part) => modelId.includes(part))) return modelId;
    return region === "ap-northeast-1" ? `jp.${modelId}` : `apac.${modelId}`;
  }

  return modelId;
}

function asHeaders(value: unknown): Record<string, string> {
  return typeof value === "object" && value !== null ? { ...(value as Record<string, string>) } : {};
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
