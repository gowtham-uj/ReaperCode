/**
 * The single place a provider client asks "what key do I authenticate with?".
 *
 * Every client used to inline its own variant of `process.env[profile.apiKeyEnv
 * ?? SOME_DEFAULT]`, which meant each one had a slightly different error
 * message and each one had to be found and changed to support credentials that
 * do not live in the environment. Now there is one rule:
 *
 *   1. `profile.apiKey` — set per-call by the app-server from configured
 *      credentials. Preferred, because it is not process-global and so cannot
 *      be raced by a concurrent thread using a different provider.
 *   2. `process.env[profile.apiKeyEnv ?? fallbackEnv]` — how CLI runs and CI
 *      have always supplied keys, and still do.
 */

import type { ResolvedModelProfile } from "./types.js";

/**
 * @param fallbackEnv the variable to read when the profile names none — each
 *   provider's conventional variable, e.g. `ANTHROPIC_API_KEY`.
 * @throws when neither source yields a key. The message names the environment
 *   variable rather than the profile field, because a user hitting this is far
 *   more likely to be fixing their shell than their app-server config.
 */
export function resolveApiKey(profile: ResolvedModelProfile, fallbackEnv: string): string {
  const direct = profile.apiKey?.trim();
  if (direct) return direct;

  const envName = profile.apiKeyEnv ?? fallbackEnv;
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `No API key for provider '${profile.provider}'. Set ${envName} in the environment, ` +
      `or add the provider under Settings so the key is supplied per request.`,
    );
  }
  return value;
}

/** Non-throwing variant, for callers that treat a missing key as "not configured". */
export function tryResolveApiKey(
  profile: ResolvedModelProfile,
  fallbackEnv: string,
): string | undefined {
  const direct = profile.apiKey?.trim();
  if (direct) return direct;
  return process.env[profile.apiKeyEnv ?? fallbackEnv]?.trim() || undefined;
}
