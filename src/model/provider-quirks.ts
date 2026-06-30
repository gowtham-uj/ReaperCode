import type { GenerateRequest, ResolvedModelProfile } from "./types.js";

export type NormalizedProviderId =
  | "anthropic"
  | "openai"
  | "minimax"
  | "minimax-oauth"
  | "deepseek"
  | "cerebras"
  | "openrouter"
  | "crazyrouter"
  | "deepinfra"
  | "mimo"
  | "zai"
  | "azure"
  | "litellm"
  | string;

export type StructuredModePreference = "native_tools" | "text_json" | "provider_json";

export interface ProviderModelIdentity {
  provider: string;
  model: string;
}

export interface RetryBackoffInput {
  attempt: number;
  durationMs?: number;
  retryAfter?: string | null;
  status?: number;
  jitterMs?: number;
}

export interface ProviderRetryPolicy {
  maxRetries: number;
  maxRateLimitRetries: number;
  retryTimeouts: boolean;
  rateLimitBaseMs: number;
  retryableBaseMs: number;
  rateLimitCapMs: number;
  retryableCapMs: number;
}

export function normalizeProviderId(provider: string): NormalizedProviderId {
  return provider.trim().toLowerCase();
}

export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

export function isProvider(input: ProviderModelIdentity, ...providers: string[]): boolean {
  const normalized = normalizeProviderId(input.provider);
  return providers.map(normalizeProviderId).includes(normalized);
}

export function isModel(input: ProviderModelIdentity, ...models: string[]): boolean {
  const normalized = normalizeModelId(input.model);
  return models.map(normalizeModelId).includes(normalized);
}

export function isMiniMaxM3(input: ProviderModelIdentity): boolean {
  return isProvider(input, "minimax", "minimax-oauth") || isModel(input, "MiniMax-M3");
}

export function prefersBufferedJsonGenerate(profile: ProviderModelIdentity, request: Pick<GenerateRequest, "responseFormat">): boolean {
  return request.responseFormat === "json" && isMiniMaxM3(profile);
}

export function getDefaultStructuredModePreference(input: ProviderModelIdentity): StructuredModePreference | undefined {
  if (isMiniMaxM3(input)) return "provider_json";
  return undefined;
}

export function supportsDeepSeekThinking(profile: ProviderModelIdentity): boolean {
  return isProvider(profile, "deepseek") && normalizeModelId(profile.model).startsWith("deepseek-v4");
}

export function buildDeepSeekThinkingParam(profile: ProviderModelIdentity): { thinking: { type: "enabled" | "disabled" } } | undefined {
  if (!supportsDeepSeekThinking(profile)) return undefined;
  return { thinking: { type: process.env.DEEPSEEK_THINKING === "1" ? "enabled" : "disabled" } };
}

export function shouldRequestStreamUsage(profile: ProviderModelIdentity): boolean {
  return isProvider(profile, "deepseek");
}

export function getProviderMaxOutputTokenCap(profile: ResolvedModelProfile): number | undefined {
  if (isProvider(profile, "deepseek")) return 8192;
  return profile.capabilities.maxOutputTokens;
}

export function getEffectiveMaxOutputTokens(profile: ResolvedModelProfile, requested?: number): number {
  const profileDefault = profile.defaultParams?.maxTokens ?? profile.capabilities.maxOutputTokens ?? 32768;
  const providerCap = getProviderMaxOutputTokenCap(profile) ?? profileDefault;
  return Math.min(requested ?? profileDefault, providerCap);
}

export function shouldUseNonStreamingJson(profile: ProviderModelIdentity, request: Pick<GenerateRequest, "responseFormat">): boolean {
  return request.responseFormat === "json" && isProvider(profile, "cerebras");
}

export function shouldUseBufferedProviderGenerate(profile: ProviderModelIdentity, request: Pick<GenerateRequest, "responseFormat">): boolean {
  return isProvider(profile, "cerebras") || prefersBufferedJsonGenerate(profile, request);
}

export function providerSupportsStreamingJson(profile: ProviderModelIdentity, request: Pick<GenerateRequest, "responseFormat">): boolean {
  return !shouldUseNonStreamingJson(profile, request);
}

export function getProviderRetryPolicy(profile: Pick<ResolvedModelProfile, "provider" | "maxRetries">): ProviderRetryPolicy {
  const baseRetries = profile.maxRetries ?? 3;
  if (isProvider({ provider: profile.provider, model: "" }, "cerebras")) {
    return {
      maxRetries: profile.maxRetries ?? 2,
      maxRateLimitRetries: Number(process.env.CEREBRAS_RATE_LIMIT_MAX_RETRIES ?? 12),
      retryTimeouts: false,
      rateLimitBaseMs: 2_000,
      retryableBaseMs: 500,
      rateLimitCapMs: 30_000,
      retryableCapMs: 4_000,
    };
  }
  return {
    maxRetries: baseRetries,
    maxRateLimitRetries: baseRetries,
    retryTimeouts: false,
    rateLimitBaseMs: 2_000,
    retryableBaseMs: 500,
    rateLimitCapMs: 30_000,
    retryableCapMs: 4_000,
  };
}

export function retryLimitForStatus(policy: Pick<ProviderRetryPolicy, "maxRetries" | "maxRateLimitRetries">, status: number): number {
  return status === 429 ? policy.maxRateLimitRetries : policy.maxRetries;
}

export function anthropicAuthHeaderForProvider(profile: ProviderModelIdentity): "x-api-key" | "X-Api-Key" {
  return isProvider(profile, "minimax-oauth") ? "X-Api-Key" : "x-api-key";
}

export function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

export function providerBackoffMs(input: RetryBackoffInput): number {
  const retryAfterMs = parseRetryAfterMs(input.retryAfter);
  if (retryAfterMs !== undefined) return Math.min(60_000, Math.max(1_000, retryAfterMs));
  const status = input.status;
  const durationMs = input.durationMs ?? 0;
  const jitter = input.jitterMs ?? Math.floor(Math.random() * 750);
  const cap = status === 429 ? 30_000 : 4_000;
  const base = status === 429 ? 2_000 : 500;
  return Math.max(250, Math.min(cap, base * Math.pow(2, input.attempt) + jitter - Math.min(durationMs, 250)));
}
