import type { ResolvedModelProfile } from "./types.js";

export interface ProviderPreflightResult {
  ok: boolean;
  provider: string;
  model: string;
  reason?: string;
}

export function checkProviderProfileReadiness(
  profile: ResolvedModelProfile,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPreflightResult {
  // `apiKeyEnv` names where a key *may* come from, not where it must. A key
  // stored in Settings is injected onto the profile per call and never touches
  // the environment, so a profile that already carries one is ready.
  if (!profile.apiKey?.trim() && profile.apiKeyEnv && !env[profile.apiKeyEnv]?.trim()) {
    return {
      ok: false,
      provider: profile.provider,
      model: profile.model,
      reason: `Environment variable '${profile.apiKeyEnv}' is required for provider '${profile.provider}'`,
    };
  }
  if (profile.apiBase) {
    try {
      const url = new URL(profile.apiBase);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      return {
        ok: false,
        provider: profile.provider,
        model: profile.model,
        reason: `Provider '${profile.provider}' has an invalid apiBase '${profile.apiBase}'`,
      };
    }
  }
  return { ok: true, provider: profile.provider, model: profile.model };
}

/*
 * Transport coverage used to be checked here, as
 * `checkProviderTransportInstalled`. It moved to `AiSdkProviderClient`, which
 * is where the transport is actually built and where the catalog is already in
 * memory. Reading the catalog from this module meant parsing 4.5 MB on the
 * first model call of every turn — about 2.5s, of which ~1.1s landed inside
 * the first-token budget — and it spent that even on the legacy wire families
 * that never consult the catalog at all.
 */

export function assertProviderProfileReady(profile: ResolvedModelProfile, env: NodeJS.ProcessEnv = process.env): void {
  const result = checkProviderProfileReadiness(profile, env);
  if (result.ok) return;
  const error = new Error(result.reason);
  Object.assign(error, { status: result.reason?.includes("Environment variable") ? 401 : 400 });
  throw error;
}
