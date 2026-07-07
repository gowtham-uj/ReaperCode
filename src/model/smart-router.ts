import {
  assertRoleCapabilities,
  parseReaperConfig,
  resolveModelRole,
  type ReaperConfig,
} from "../config/model-config.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "./types.js";
import type { ProviderModelClient } from "./gateway.js";
import { classifyModelError, type ModelErrorKind } from "./error-taxonomy.js";
import { getEngineTunables } from "../config/config-tunables.js";


interface RouterStats {
  attempts: number;
  successes: number;
  failures: number;
  lastLatencyMs?: number;
  ewmaLatencyMs?: number;
  lastErrorKind?: ModelErrorKind;
}

export interface SmartModelRouterOptions {
  latencySloMs?: number;
  hedgeDelayMs?: number;
  llmDecisionTimeoutMs?: number;
  enableLlmDecision?: boolean;
  onRoute?: (event: SmartModelRouteEvent) => void | Promise<void>;
}

export interface SmartModelRouteEvent {
  role: ModelRole;
  selectedProfile: ModelRole;
  selectedModel: string;
  strategy: "primary" | "fallback" | "hedged" | "telemetry_fallback" | "llm_primary" | "llm_fallback";
  reason: string;
  latencyMs?: number;
}

type RouteStrategy = SmartModelRouteEvent["strategy"];

export class SmartModelRouterGateway implements ModelGateway {
  private readonly config: ReaperConfig;
  private readonly latencySloMs: number;
  private readonly hedgeDelayMs: number;
  private readonly llmDecisionTimeoutMs: number;
  private readonly enableLlmDecision: boolean;
  private readonly stats = new Map<string, RouterStats>();

  constructor(config: ReaperConfig | unknown, private readonly client: ProviderModelClient, private readonly options: SmartModelRouterOptions = {}) {
    this.config = parseReaperConfig(config);
    this.latencySloMs = options.latencySloMs ?? readPositiveIntEnv("REAPER_MODEL_ROUTER_LATENCY_SLO_MS", 60_000);
    this.hedgeDelayMs = options.hedgeDelayMs ?? readPositiveIntEnv("REAPER_MODEL_ROUTER_HEDGE_DELAY_MS", this.latencySloMs);
    this.llmDecisionTimeoutMs = options.llmDecisionTimeoutMs ?? readPositiveIntEnv("REAPER_MODEL_ROUTER_LLM_DECISION_TIMEOUT_MS", 10_000);
    this.enableLlmDecision = options.enableLlmDecision ?? getEngineTunables().modelRouterLlmDecisions === true;
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return resolveModelRole(this.config, role);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const primary = await this.resolveRole(request.role);
    this.assertGenerateCompatibility(request, primary);
    const fallbacks = this.resolveFallbackProfiles(primary).filter((fallback) => !sameModel(primary, fallback));

    if (fallbacks.length === 0) {
      return this.callProfile(request, primary, "primary", "no fallback candidate configured");
    }

    for (const fallback of fallbacks) {
      this.assertGenerateCompatibility(request, fallback);
    }
    const telemetryChoice = this.chooseByTelemetry(request.role, primary, fallbacks);
    if (telemetryChoice) {
      return this.callProfileWithFailover(
        request,
        telemetryChoice.profile,
        fallbacks.filter((fallback) => !sameModel(fallback, telemetryChoice.profile)),
        "telemetry_fallback",
        telemetryChoice.reason,
      );
    }

    const llmChoice = await this.chooseWithRouterModel(request, primary, fallbacks);
    if (llmChoice && llmChoice !== "primary") {
      return this.callProfileWithFailover(
        request,
        llmChoice,
        fallbacks.filter((fallback) => !sameModel(fallback, llmChoice)),
        "llm_fallback",
        "router model selected a lower-latency fallback for this request",
      );
    }
    if (llmChoice === "primary") {
      const fallback = this.bestFallbackCandidate(fallbacks);
      return this.callWithHedge(
        request,
        primary,
        fallback,
        fallbacks.filter((candidate) => !sameModel(candidate, fallback)),
        "llm_primary",
        "router model selected primary quality model",
      );
    }

    const fallback = this.bestFallbackCandidate(fallbacks);
    if (isLatencyFirstRole(request.role)) {
      return this.callWithHedge(
        request,
        primary,
        fallback,
        fallbacks.filter((candidate) => !sameModel(candidate, fallback)),
        "hedged",
        "latency-first role with blanket fallback",
      );
    }

    return this.callWithHedge(
      request,
      primary,
      fallback,
      fallbacks.filter((candidate) => !sameModel(candidate, fallback)),
      "hedged",
      `primary hedged after ${this.hedgeDelayMs}ms latency SLO`,
    );
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const primary = await this.resolveRole(request.role);
    this.assertGenerateCompatibility(request, primary, true);
    const routed = this.chooseByTelemetry(request.role, primary, this.resolveFallbackProfiles(primary));
    const profile = routed?.profile ?? primary;

    for await (const event of this.client.stream(request, profile)) {
      yield event;
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    assertRoleCapabilities(this.config, request.role);
    const profile = await this.resolveRole(request.role);
    if (!profile.capabilities.embeddings) {
      throw new Error(`Role '${request.role}' requires a profile with embeddings=true`);
    }
    return this.client.embed(request, profile);
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    await this.resolveRole(request.role);
    const normalized = request.text.trim();
    return normalized ? Math.max(1, Math.ceil(normalized.length / 4)) : 0;
  }

  async dispose(): Promise<void> {
    await this.client.dispose?.();
  }

  private resolveFallbackProfiles(primary: ResolvedModelProfile): ResolvedModelProfile[] {
    const profiles: ResolvedModelProfile[] = [];
    if (primary.fallbackProfile && primary.fallbackProfile !== primary.profileName) {
      profiles.push(resolveModelRole(this.config, primary.fallbackProfile));
    }
    if (primary.role === "default_model" || primary.role === "secondary_model" || primary.role === "judge") {
      if (this.config.models["fast_reasoner"] && "fast_reasoner" !== primary.profileName) {
        profiles.push(resolveModelRole(this.config, "fast_reasoner"));
      }
    }
    return uniqueProfiles(profiles);
  }

  private chooseByTelemetry(
    role: ModelRole,
    primary: ResolvedModelProfile,
    fallbacks: ResolvedModelProfile[],
  ): { profile: ResolvedModelProfile; reason: string } | undefined {
    if (fallbacks.length === 0) {
      return undefined;
    }
    const primaryStats = this.stats.get(profileKey(primary));
    const healthyFallbacks = fallbacks.filter((fallback) => !isUnhealthy(this.stats.get(profileKey(fallback))));
    if (primaryStats && isSlow(primaryStats, this.latencySloMs) && healthyFallbacks.length > 0) {
      return { profile: this.lowestLatencyProfile(healthyFallbacks), reason: `primary EWMA/last latency exceeded ${this.latencySloMs}ms` };
    }
    const fastestFallback = healthyFallbacks.length > 0 ? this.lowestLatencyProfile(healthyFallbacks) : undefined;
    const fastestFallbackStats = fastestFallback ? this.stats.get(profileKey(fastestFallback)) : undefined;
    if (isLatencyFirstRole(role) && fastestFallback && fastestFallbackStats?.ewmaLatencyMs && primaryStats?.ewmaLatencyMs && fastestFallbackStats.ewmaLatencyMs < primaryStats.ewmaLatencyMs) {
      return { profile: fastestFallback, reason: "fallback has better observed latency for latency-first role" };
    }
    return undefined;
  }

  private async chooseWithRouterModel(
    request: GenerateRequest,
    primary: ResolvedModelProfile,
    fallbacks: ResolvedModelProfile[],
  ): Promise<ResolvedModelProfile | "primary" | undefined> {
    const promptText = request.messages.map((m) => m.content).join(" ");
    // Very conservative fast-path: only for extremely short interactive prompts, never for the high-context secondary model implementation.
    if (promptText.length < 50 && request.role !== "secondary_model") {
      return fallbacks.find((f) => f.role === "fast_reasoner") ?? "primary";
    }

    if (!this.enableLlmDecision || isLatencyFirstRole(request.role)) {
      return undefined;
    }
    // The historical "cheap_router" role was a separate model used
    // for LLM-driven route decisions. It was removed in v0.2; this
    // method now returns undefined (no LLM-routed fallback) unless
    // the fast-path above already picked one. We keep the original
    // method signature so callers stay stable.
    return undefined;
  }

  private async callWithHedge(
    request: GenerateRequest,
    primary: ResolvedModelProfile,
    fallback: ResolvedModelProfile,
    remainingFallbacks: ResolvedModelProfile[],
    strategy: RouteStrategy,
    reason: string,
  ): Promise<GenerateResult> {
    let timer: NodeJS.Timeout | undefined;
    let primarySettled = false;
    let fallbackStarted = false;
    // The original primary error, captured when the primary rejects with
    // a non-fallback-classifiable error. Without this, `Promise.any`
    // combined with the hedging timer would surface a hedge-timeout
    // rejection and the user would lose the real cause. We re-throw
    // this in the `catch` arm below.
    let primaryNonFallbackError: unknown;
    let fallbackCall: Promise<GenerateResult> | undefined;
    const startFallback = (fallbackReason: string) => {
      if (!fallbackStarted) {
        fallbackStarted = true;
        if (timer) clearTimeout(timer);
        fallbackCall = this.callProfileWithFailover(request, fallback, remainingFallbacks, "hedged", fallbackReason);
      }
      return fallbackCall!;
    };
    const primaryPromise = this.callProfile(request, primary, strategy, reason).catch((error) => {
      const classified = classifyModelError(error);
      if (classified.suggestsFallback) {
        return startFallback(`fallback launched immediately after ${classified.kind} from primary`);
      }
      // Stash the original error so the outer catch can re-throw it.
      primaryNonFallbackError = error;
      // Return a never-resolving promise so Promise.any does not pick it.
      // The hedge timer becomes the only resolver, and we re-throw the
      // stashed error below.
      return new Promise<GenerateResult>(() => {
        /* never resolves */
      });
    });
    const fallbackPromise = new Promise<GenerateResult>((resolve, reject) => {
      timer = setTimeout(() => {
        if (primarySettled) {
          return;
        }
        startFallback(`fallback hedge launched after ${this.hedgeDelayMs}ms`).then(resolve, reject);
      }, this.hedgeDelayMs);
    });
    // We do NOT silence rejection on these — if either promise rejects
    // for a reason other than the stashed primary error, that rejection
    // must propagate to the outer try/catch. (The previous code attached
    // `.catch(() => undefined)` to both, which silently dropped the
    // primary's real error.)
    void primaryPromise;
    void fallbackPromise;

    try {
      const result = await Promise.any([primaryPromise, fallbackPromise]);
      primarySettled = true;
      if (timer) {
        clearTimeout(timer);
      }
      return result;
    } catch (error) {
      primarySettled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (primaryNonFallbackError !== undefined) {
        throw primaryNonFallbackError;
      }
      throw error instanceof AggregateError && error.errors[0] ? error.errors[0] : error;
    }
  }

  private async callProfileWithFailover(
    request: GenerateRequest,
    profile: ResolvedModelProfile,
    fallbacks: ResolvedModelProfile[],
    strategy: RouteStrategy,
    reason: string,
  ): Promise<GenerateResult> {
    try {
      return await this.callProfile(request, profile, strategy, reason);
    } catch (error) {
      const classified = classifyModelError(error);
      if (!classified.suggestsFallback) {
        throw error;
      }
      let lastError = error;
      for (const fallback of this.orderedFallbackCandidates(fallbacks)) {
        try {
          return await this.callProfile(request, fallback, "fallback", `previous route failed with ${classified.kind}`);
        } catch (fallbackError) {
          lastError = fallbackError;
          if (!classifyModelError(fallbackError).suggestsFallback) {
            throw fallbackError;
          }
        }
      }
      throw lastError;
    }
  }

  private async callProfile(
    request: GenerateRequest,
    profile: ResolvedModelProfile,
    strategy: RouteStrategy,
    reason: string,
  ): Promise<GenerateResult> {
    const startedAt = Date.now();
    try {
      const result = await this.client.generate(request, profile);
      const latencyMs = Date.now() - startedAt;
      this.record(profile, latencyMs, true);
      await this.reportRoute({ role: request.role, selectedProfile: profile.profileName, selectedModel: profile.model, strategy, reason, latencyMs });
      return result;
    } catch (error) {
      const classified = classifyModelError(error);
      this.record(profile, Date.now() - startedAt, false, classified.kind);
      throw error;
    }
  }

  private lowestLatencyProfile(profiles: ResolvedModelProfile[]): ResolvedModelProfile {
    return profiles.reduce((best, profile) => {
      const bestLatency = this.stats.get(profileKey(best))?.ewmaLatencyMs ?? Number.POSITIVE_INFINITY;
      const profileLatency = this.stats.get(profileKey(profile))?.ewmaLatencyMs ?? Number.POSITIVE_INFINITY;
      return profileLatency < bestLatency ? profile : best;
    });
  }

  private bestFallbackCandidate(fallbacks: ResolvedModelProfile[]): ResolvedModelProfile {
    const healthyFallbacks = fallbacks.filter((fallback) => !isUnhealthy(this.stats.get(profileKey(fallback))));
    return this.lowestLatencyProfile(healthyFallbacks.length > 0 ? healthyFallbacks : fallbacks);
  }

  private orderedFallbackCandidates(fallbacks: ResolvedModelProfile[]): ResolvedModelProfile[] {
    const healthyFallbacks = fallbacks.filter((fallback) => !isUnhealthy(this.stats.get(profileKey(fallback))));
    const candidates = healthyFallbacks.length > 0 ? healthyFallbacks : fallbacks;
    return [...candidates].sort((left, right) => {
      const leftLatency = this.stats.get(profileKey(left))?.ewmaLatencyMs ?? Number.POSITIVE_INFINITY;
      const rightLatency = this.stats.get(profileKey(right))?.ewmaLatencyMs ?? Number.POSITIVE_INFINITY;
      return leftLatency - rightLatency;
    });
  }

  private record(profile: ResolvedModelProfile, latencyMs: number, ok: boolean, errorKind?: ModelErrorKind): void {
    const key = profileKey(profile);
    const current = this.stats.get(key) ?? { attempts: 0, successes: 0, failures: 0 };
    const previousEwma = current.ewmaLatencyMs ?? latencyMs;
    current.attempts += 1;
    current.lastLatencyMs = latencyMs;
    current.ewmaLatencyMs = previousEwma * 0.7 + latencyMs * 0.3;
    if (ok) {
      current.successes += 1;
      delete current.lastErrorKind;
    } else {
      current.failures += 1;
      if (errorKind) {
        current.lastErrorKind = errorKind;
      } else {
        delete current.lastErrorKind;
      }
    }
    this.stats.set(key, current);
  }

  private assertGenerateCompatibility(request: GenerateRequest, profile: ResolvedModelProfile, streaming = false): void {
    assertRoleCapabilities(this.config, request.role);
    if (streaming && !profile.capabilities.streaming) {
      throw new Error(`Role '${request.role}' requires a profile with streaming=true`);
    }
    if (request.tools && request.tools.length > 0 && !profile.capabilities.toolCalling) {
      throw new Error(`Role '${request.role}' requires a profile with toolCalling=true`);
    }
    if (request.responseFormat === "json" && !profile.capabilities.jsonMode) {
      throw new Error(`Role '${request.role}' requires a profile with jsonMode=true`);
    }
  }

  private async reportRoute(event: SmartModelRouteEvent): Promise<void> {
    await this.options.onRoute?.(event);
  }
}

function isLatencyFirstRole(role: ModelRole): boolean {
  return role === "fast_reasoner";
}

function isSlow(stats: RouterStats, latencySloMs: number): boolean {
  return (stats.lastLatencyMs ?? 0) > latencySloMs || (stats.ewmaLatencyMs ?? 0) > latencySloMs;
}

function isUnhealthy(stats: RouterStats | undefined): boolean {
  return Boolean(
    stats &&
      (
        ((stats.lastErrorKind === "provider_unavailable" || stats.lastErrorKind === "auth") && stats.failures >= 1) ||
        (stats.failures >= 2 && stats.failures > stats.successes)
      ),
  );
}

function sameModel(left: ResolvedModelProfile, right: ResolvedModelProfile): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function profileKey(profile: ResolvedModelProfile): string {
  return `${profile.provider}:${profile.model}:${profile.profileName}`;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueProfiles(profiles: ResolvedModelProfile[]): ResolvedModelProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const key = profileKey(profile);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
