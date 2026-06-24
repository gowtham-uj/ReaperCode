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
import { classifyModelError } from "./error-taxonomy.js";
import { assertProviderProfileReady } from "./preflight.js";

export interface ProviderModelClient {
  generate(request: GenerateRequest, profile: ResolvedModelProfile): Promise<GenerateResult>;
  stream(request: GenerateRequest, profile: ResolvedModelProfile): AsyncIterable<StreamEvent>;
  embed(request: EmbeddingRequest, profile: ResolvedModelProfile): Promise<EmbeddingResult>;
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Phase T2.6: structured router-decision event surface
// ---------------------------------------------------------------------------

export type RouterStrategy =
  | "primary"
  | "fallback"
  | "hedged"
  | "telemetry_fallback"
  | "llm_primary"
  | "llm_fallback";

/**
 * Single event emitted per model call by `ConfiguredModelGateway`. The
 * shape is intentionally narrower than `SmartModelRouterGateway`'s
 * `SmartModelRouteEvent` (which has its own richer EWMA/hedge state);
 * ConfiguredModelGateway reports the final route decision after its
 * `withFallback` chain has resolved. The two can be unified later when
 * SmartModelRouterGateway becomes the default gateway.
 */
export interface RouterDecisionEvent {
  role: ModelRole;
  selectedProfile: ModelRole;
  selectedModel: string;
  provider: string;
  strategy: RouterStrategy;
  reason: string;
  latencyMs?: number;
  /** True when the call landed on the primary profile with no fallback
   *  ever tried. Lets downstream consumers distinguish a clean
   *  primary hit from a recovery path. */
  resolvedOnPrimary: boolean;
}

export interface ConfiguredModelGatewayOptions {
  /**
   * Phase T2.6: invoked once per model call with a structured
   * `RouterDecisionEvent` describing which profile+strategy the
   * gateway actually used. Best-effort — a listener that throws
   * does not derail the model loop. The trajectory logger is the
   * natural consumer; wire it via
   * `new ConfiguredModelGateway(config, client, { onRoute: ... })`.
   */
  onRoute?: (event: RouterDecisionEvent) => void | Promise<void>;
}

export class ConfiguredModelGateway implements ModelGateway {
  private readonly config: ReaperConfig;
  private readonly options: ConfiguredModelGatewayOptions;

  constructor(
    config: ReaperConfig | unknown,
    private readonly client: ProviderModelClient,
    options: ConfiguredModelGatewayOptions = {},
  ) {
    this.config = parseReaperConfig(config);
    this.options = options;
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return resolveModelRole(this.config, role);
  }

  /**
   * Phase T2.6: install or replace the `onRoute` callback. Use this
   * when the gateway was constructed before the listener was
   * available (e.g. when the engine receives a `ModelGateway` from
   * outside and only later learns the trajectory logger to write to).
   * Idempotent — calling twice with the same function is fine.
   */
  setOnRoute(callback: ConfiguredModelGatewayOptions["onRoute"] | undefined): void {
    if (callback === undefined) {
      delete this.options.onRoute;
    } else {
      this.options.onRoute = callback;
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const profile = await this.resolveRole(request.role);
    this.assertGenerateCompatibility(request, profile);
    return this.withFallback(profile, request.role, (resolvedProfile) => this.client.generate(request, resolvedProfile), "primary");
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const profile = await this.resolveRole(request.role);
    this.assertGenerateCompatibility(request, profile, true);
    // Note: streaming doesn't go through withFallback — providers are
    // expected to surface failures inline via StreamEvent errors. The
    // router_decision event for streams is emitted up-front with no
    // latency (streaming latency is measured by the consumer).
    await this.emitRoute({
      role: request.role,
      selectedProfile: profile.profileName,
      selectedModel: profile.model,
      provider: profile.provider,
      strategy: "primary",
      reason: "primary profile (streaming path does not auto-failover)",
      resolvedOnPrimary: true,
    });

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
    return this.withFallback(profile, request.role, (resolvedProfile) => this.client.embed(request, resolvedProfile), "primary");
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    await this.resolveRole(request.role);
    const normalized = request.text.trim();
    if (!normalized) return 0;

    return Math.max(1, Math.ceil(normalized.length / 4));
  }

  async dispose(): Promise<void> {
    await this.client.dispose?.();
  }

  private async emitRoute(event: RouterDecisionEvent): Promise<void> {
    if (!this.options.onRoute) return;
    try {
      await this.options.onRoute(event);
    } catch {
      /* swallow — router telemetry must never derail a model call */
    }
  }

  private assertGenerateCompatibility(
    request: GenerateRequest,
    profile: ResolvedModelProfile,
    streaming = false,
  ): void {
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

  private async withFallback<T>(
    profile: ResolvedModelProfile,
    role: ModelRole,
    fn: (profile: ResolvedModelProfile) => Promise<T>,
    primaryStrategy: RouterStrategy,
    seen: Set<ModelRole> = new Set(),
  ): Promise<T> {
    assertProviderProfileReady(profile);
    const startedAt = Date.now();
    try {
      const result = await fn(profile);
      const latencyMs = Date.now() - startedAt;
      // The success emit uses the ACTUAL profile we just called,
      // not the `primaryStrategy` argument (which describes the
      // outer call's original intent). When the recursive call lands
      // here for a fallback profile, `seen` is non-empty (the primary
      // has been added) — so we mark `resolvedOnPrimary: false` and
      // label the strategy as `fallback`. The original `primaryStrategy`
      // is preserved in the reason for traceability.
      const isRecursiveCall = seen.size > 0;
      const resolvedOnPrimary = !isRecursiveCall;
      await this.emitRoute({
        role,
        selectedProfile: profile.profileName,
        selectedModel: profile.model,
        provider: profile.provider,
        strategy: resolvedOnPrimary ? primaryStrategy : "fallback",
        reason: resolvedOnPrimary
          ? "primary resolved without fallback"
          : `primary ${primaryStrategy} served by fallback ${profile.profileName}`,
        latencyMs,
        resolvedOnPrimary,
      });
      return result;
    } catch (error) {
      const classified = classifyModelError(error);
      if (
        !classified.suggestsFallback ||
        !profile.fallbackProfile ||
        profile.fallbackProfile === profile.profileName ||
        seen.has(profile.fallbackProfile)
      ) {
        // Phase T2.6: even failure paths emit a route event so the
        // trajectory captures "primary failed with X" decisions.
        await this.emitRoute({
          role,
          selectedProfile: profile.profileName,
          selectedModel: profile.model,
          provider: profile.provider,
          strategy: primaryStrategy,
          reason: `primary failed (${classified.kind}); no fallback eligible`,
          latencyMs: Date.now() - startedAt,
          resolvedOnPrimary: true,
        });
        throw error;
      }

      seen.add(profile.profileName);
      const fallback = resolveModelRole(this.config, profile.fallbackProfile);
      // Preflight the fallback BEFORE recursing. A misconfigured fallback
      // (missing model, bad API key) should fail fast on the preflight
      // hook rather than 404 inside the request — that was the cause of
      // the 3d-post-generic-stuck eval failures where Cerebras returned
      // 404 for a model the account didn't have, after the primary had
      // already failed and burned a turn.
      assertProviderProfileReady(fallback);
      // Emit the primary-failed event BEFORE recursing into the
      // fallback. The recursive success event will land second,
      // giving the trajectory a complete "primary failed → fallback
      // resolved" pair.
      await this.emitRoute({
        role,
        selectedProfile: profile.profileName,
        selectedModel: profile.model,
        provider: profile.provider,
        strategy: primaryStrategy,
        reason: `primary ${profile.profileName} failed (${classified.kind}); falling back to ${fallback.profileName}`,
        latencyMs: Date.now() - startedAt,
        resolvedOnPrimary: true,
      });
      return this.withFallback(fallback, role, fn, primaryStrategy, seen);
    }
  }
}
