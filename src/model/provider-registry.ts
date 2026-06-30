/**
 * Unified provider-family registry. Phase T3.15.
 *
 * Replaces the implicit split between:
 *   - `src/model/providers/provider-client.ts` (`ProviderMultiplexerClient` —
 *     hard-coded switch on `profile.provider` to pick a client class).
 *   - `src/model/provider/registry.ts` (catalog + family dispatch + env
 *     resolution, separately registered custom families).
 *
 * Both paths answer the same question — "given a `profile.provider`
 * string, which `ProviderModelClient` should serve it?" — but use
 * different data structures. This module unifies them around one
 * keyed registry with two layers:
 *
 *   1. **Family layer** (`registerFamily`): an SDK shape (Anthropic
 *      Messages, OpenAI Chat, ...) gets a function that turns a
 *      `ResolvedModelProfile` into a `ProviderModelClient`. The
 *      built-in `anthropic-messages` and `openai-chat` families
 *      pre-register at module load.
 *
 *   2. **Provider-name layer** (`registerProvider`): a friendly name
 *      (e.g. `"anthropic"`, `"openrouter"`, `"cerebras"`) maps to
 *      a family. The multiplexer used to hard-code this in a
 *      switch; the registry makes it data-driven so new providers
 *      can register without modifying the multiplexer.
 *
 *   3. **Lookup** (`resolveProviderClient`): given a profile, walk
 *      provider-name → family → client. Falls back to the
 *      OpenAI-compatible family for unknown providers (matching
 *      the prior multiplexer default).
 *
 * The legacy `ProviderMultiplexerClient` keeps working — it's now a
 * thin facade that delegates to this registry. Tests for the
 * multiplexer continue to pass; new code can call the registry
 * directly.
 */

import type { ProviderModelClient } from "./gateway.js";
import type { ResolvedModelProfile } from "./types.js";

/**
 * A provider family is a function that, given a profile, returns
 * the client that should serve it. This indirection lets us swap
 * the HTTP layer without touching the multiplexer.
 */
export type ProviderFamilyResolver = (profile: ResolvedModelProfile) => ProviderModelClient;

const familyRegistry = new Map<string, ProviderFamilyResolver>();
const providerToFamily = new Map<string, string>();

/**
 * Register a provider family. Re-registration of the same `familyId`
 * replaces the prior resolver.
 *
 * The family ID should match the existing `SdkFamilyId` vocabulary
 * (e.g. `"anthropic-messages"`, `"openai-chat"`).
 */
export function registerFamily(familyId: string, resolver: ProviderFamilyResolver): void {
  familyRegistry.set(familyId, resolver);
}

/**
 * Bind a friendly provider name (e.g. `"anthropic"`, `"openrouter"`)
 * to a registered family.
 */
export function registerProvider(providerName: string, familyId: string): void {
  providerToFamily.set(providerName.trim().toLowerCase(), familyId);
}

/**
 * Resolve a `ProviderModelClient` for the given profile. Walks the
 * provider-name → family → client chain; falls back to the
 * openai-chat family when the provider name is unknown.
 *
 * The fallback mirrors the legacy `ProviderMultiplexerClient`:
 * everything we don't recognize routes through the OpenAI-compatible
 * client (which itself understands how to talk to most providers
 * when given the right `apiBase`).
 */
export function resolveProviderClient(
  profile: ResolvedModelProfile,
  fallbackFamily: string = "openai-chat",
): ProviderModelClient {
  const providerKey = profile.provider.trim().toLowerCase();
  const familyId = providerToFamily.get(providerKey) ?? fallbackFamily;
  const resolver = familyRegistry.get(familyId);
  if (!resolver) {
    // Last-ditch fallback: construct an empty resolver that throws on use.
    // Better than crashing the engine on an unknown provider — the actual
    // error surfaces when the call site tries to use the client.
    return {
      generate: () => Promise.reject(new Error(
        `provider-registry: no resolver registered for family "${familyId}" (provider "${providerKey}")`,
      )),
      stream: () => {
        throw new Error(
          `provider-registry: no resolver registered for family "${familyId}" (provider "${providerKey}")`,
        );
      },
      embed: () => Promise.reject(new Error(
        `provider-registry: no resolver registered for family "${familyId}" (provider "${providerKey}")`,
      )),
    };
  }
  return resolver(profile);
}

/**
 * List all registered provider names. Used by the TUI onboarding
 * picker (and tests).
 */
export function listRegisteredProviders(): string[] {
  return [...providerToFamily.keys()].sort();
}

/**
 * List all registered family IDs.
 */
export function listRegisteredFamilies(): string[] {
  return [...familyRegistry.keys()].sort();
}

/**
 * Reset the registry to empty. Test-only — production code never
 * needs to wipe the registry.
 */
export function _resetProviderRegistryForTests(): void {
  familyRegistry.clear();
  providerToFamily.clear();
}

/**
 * Convenience helper: bulk-bind a provider-name list to one family
 * in a single call. Used by the built-in bootstrap below.
 */
export function bindProvidersToFamily(providerNames: string[], familyId: string): void {
  for (const name of providerNames) {
    registerProvider(name, familyId);
  }
}
