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
  if (profile.apiKeyEnv && !env[profile.apiKeyEnv]?.trim()) {
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

export function assertProviderProfileReady(profile: ResolvedModelProfile, env: NodeJS.ProcessEnv = process.env): void {
  const result = checkProviderProfileReadiness(profile, env);
  if (result.ok) return;
  const error = new Error(result.reason);
  Object.assign(error, { status: result.reason?.includes("Environment variable") ? 401 : 400 });
  throw error;
}
