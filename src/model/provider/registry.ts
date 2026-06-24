/**
 * model/provider/registry.ts — turns the static catalog into runtime
 * objects. The agent loop imports this once and forgets about it.
 *
 * Responsibilities:
 *   1. Resolve a `ProviderDescriptor` against the current process
 *      (read env var, pick the right `SdkFamilyAdapter`).
 *   2. Construct an `SdkFamilyAdapter` for built-in families.
 *   3. Construct a `ModelProvider` bound to (provider, model, role).
 *   4. Decide which provider wins when env has multiple keys.
 *
 * The loop never calls any of this directly — it asks the gateway
 * for a `ResolvedModel`, and the gateway calls the registry under
 * the hood.
 */

import {
  PROVIDER_CATALOG,
  findProviderDescriptor,
} from "./catalog.js";
import { anthropicMessagesFamily } from "./families/anthropic-messages.js";
import { openaiChatFamily } from "./families/openai-chat.js";
import type {
  ModelProvider,
  ProviderDescriptor,
  ProviderId,
  ResolvedModel,
  ResolvedProvider,
  SdkFamilyAdapter,
  SdkFamilyId,
} from "./types.js";

/**
 * Legacy env aliases — when the user has an old `ANTHROPIC_AUTH_TOKEN`
 * sitting around, we accept it as a fallback for any provider whose
 * primary env var is unset. Avoids breaking the pre-onboarding
 * workflow.
 */
const LEGACY_ENV_FALLBACKS: Record<string, string[]> = {
  ANTHROPIC_API_KEY: ["ANTHROPIC_AUTH_TOKEN"],
  OPENAI_API_KEY: ["ANTHROPIC_AUTH_TOKEN"],
  MINIMAX_API_KEY: ["ANTHROPIC_AUTH_TOKEN"],
  DEEPSEEK_API_KEY: ["ANTHROPIC_AUTH_TOKEN"],
  CEREBRAS_API_KEY: ["ANTHROPIC_AUTH_TOKEN"],
  OPENROUTER_API_KEY: ["ANTHROPIC_AUTH_TOKEN"],
};

/**
 * Read the API key for a provider, respecting legacy fallbacks.
 * Returns `undefined` when no key is available.
 */
function readApiKey(envVar: string): string | undefined {
  const direct = process.env[envVar];
  if (direct && direct.trim().length > 0) return direct;
  const fallbacks = LEGACY_ENV_FALLBACKS[envVar];
  if (fallbacks) {
    for (const alias of fallbacks) {
      const v = process.env[alias];
      if (v && v.trim().length > 0) return v;
    }
  }
  return undefined;
}

/**
 * Resolve a `ProviderDescriptor` into a runtime `ResolvedProvider`.
 * Throws when the env var is missing — the caller decides whether
 * to surface that as a TUI error or a CLI error.
 */
export function resolveProvider(
  descriptor: ProviderDescriptor,
): ResolvedProvider {
  const apiKey = readApiKey(descriptor.envVar);
  if (!apiKey) {
    throw new Error(
      `provider "${descriptor.id}" requires ${descriptor.envVar} ` +
        `(or ANTHROPIC_AUTH_TOKEN) in the environment`,
    );
  }
  return { descriptor, apiKey };
}

/**
 * Pick the family adapter for a descriptor. Built-in families are
 * imported statically (they're small); custom families register
 * their own via `registerCustomFamily()`.
 */
export function familyFor(sdkFamily: SdkFamilyId): SdkFamilyAdapter {
  switch (sdkFamily) {
    case "anthropic-messages":
      return anthropicMessagesFamily;
    case "openai-chat":
      return openaiChatFamily;
    case "custom":
      throw new Error(
        "sdkFamily 'custom' requires the custom client to be " +
          "registered via registerCustomFamily() before use",
      );
  }
}

/**
 * Registry of custom-family adapters, keyed by an arbitrary id the
 * catalog author picks. Custom providers (Bedrock, Azure ADX, etc.)
 * call this at module load to expose themselves.
 */
const customFamilyRegistry = new Map<string, SdkFamilyAdapter>();

export function registerCustomFamily(id: string, adapter: SdkFamilyAdapter): void {
  customFamilyRegistry.set(id, adapter);
}

export function getCustomFamily(id: string): SdkFamilyAdapter | undefined {
  return customFamilyRegistry.get(id);
}

/**
 * Build a `ModelProvider` for (provider id, model id, role).
 * Throws on unknown id or missing env var.
 */
export function buildProvider(args: {
  providerId: ProviderId;
  modelId?: string;
  role: ResolvedModel["role"];
}): ModelProvider {
  const descriptor = findProviderDescriptor(args.providerId);
  if (!descriptor) {
    throw new Error(`unknown provider "${args.providerId}"`);
  }
  const modelId = args.modelId ?? descriptor.defaultModel;
  if (!descriptor.models.includes(modelId)) {
    throw new Error(
      `model "${modelId}" is not in the ${descriptor.id} catalogue — ` +
        `available: ${descriptor.models.join(", ")}`,
    );
  }
  const resolved = resolveProvider(descriptor);
  const family = familyFor(descriptor.sdkFamily);
  const model: ResolvedModel = {
    providerId: descriptor.id,
    modelId,
    role: args.role,
    capabilities: descriptor.capabilities,
  };
  return family.buildProvider({ descriptor, resolved, model });
}

/**
 * Resolve a `ResolvedModel` for a given provider id, defaulting to
 * the catalogue's `defaultModel` when none is specified. Pure data
 * — no env reads.
 */
export function resolveModelFromCatalog(args: {
  providerId: ProviderId;
  modelId?: string;
  role: ResolvedModel["role"];
}): ResolvedModel {
  const descriptor = findProviderDescriptor(args.providerId);
  if (!descriptor) {
    throw new Error(`unknown provider "${args.providerId}"`);
  }
  const modelId = args.modelId ?? descriptor.defaultModel;
  return {
    providerId: descriptor.id,
    modelId,
    role: args.role,
    capabilities: descriptor.capabilities,
  };
}

/**
 * Auto-detect which provider to use from the environment. Returns
 * the first provider in `PROVIDER_CATALOG` whose env var (or its
 * legacy alias) is set. Returns `undefined` when nothing is set —
 * the caller falls back to the TUI onboarding flow.
 */
export function autoDetectProvider(): ProviderDescriptor | undefined {
  for (const descriptor of PROVIDER_CATALOG) {
    if (readApiKey(descriptor.envVar)) return descriptor;
  }
  return undefined;
}

/**
 * The list of providers the TUI onboarding picker should show. This
 * is the catalogue minus any providers the user has explicitly
 * hidden via future config — for now, all entries.
 */
export function listProvidersForOnboarding(): ProviderDescriptor[] {
  return [...PROVIDER_CATALOG];
}
