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
import { logModelCall, nextCallId } from "../logging/model-call-log.js";
import {
  getExtensionLifecycleEventBus,
  type ExtensionLifecycleEventBus,
} from "../extensions/lifecycle-events.js";

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
  /**
   * Direct lifecycle event wiring for extension-observable model calls.
   * before_model_request receives the mutable GenerateRequest object before
   * compatibility checks/provider dispatch; after_model_response observes
   * success or failure metadata.
   */
  lifecycleBus?: ExtensionLifecycleEventBus;
}

export class ConfiguredModelGateway implements ModelGateway {
  private readonly config: ReaperConfig;
  private readonly options: ConfiguredModelGatewayOptions;
  private readonly lifecycleBus: ExtensionLifecycleEventBus;

  constructor(
    config: ReaperConfig | unknown,
    private readonly client: ProviderModelClient,
    options: ConfiguredModelGatewayOptions = {},
  ) {
    this.config = parseReaperConfig(config);
    this.options = options;
    this.lifecycleBus = options.lifecycleBus ?? getExtensionLifecycleEventBus();
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
    await this.emitBeforeModelRequest(request);
    const profile = await this.resolveRole(request.role);
    this.assertGenerateCompatibility(request, profile);
    const callId = nextCallId("active", "generate");
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    try {
      const result = await this.withFallback(profile, request.role, (resolvedProfile) => this.client.generate(request, resolvedProfile), "primary");
      await this.emitAfterModelResponse(request, result);
      await logModelCall({
        kind: "generate",
        callId,
        role: request.role,
        profile,
        request,
        response: result,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
      return result;
    } catch (error) {
      await this.emitAfterModelResponse(request, undefined, error);
      await logModelCall({
        kind: "generate",
        callId,
        role: request.role,
        profile,
        request,
        error,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    await this.emitBeforeModelRequest(request);
    const profile = await this.resolveRole(request.role);
    this.assertGenerateCompatibility(request, profile, true);
    const callId = nextCallId("active", "stream");
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const events: StreamEvent[] = [];
    let streamUsage: unknown;
    try {
      // For streaming, the primary path is preferred because it has the
      // lowest latency. However, if the primary provider fails BEFORE the
      // first event, fall back to the configured fallback profile to
      // preserve long-running agent sessions. Mid-stream failures are
      // surfaced inline via StreamEvent errors (we don't restart the
      // stream because the consumer is already in the middle of reading).
      for await (const event of this.streamWithFallback(profile, request)) {
        events.push(event);
        if (event.type === "message_end") {
          streamUsage = (event.data as { usage?: unknown } | undefined)?.usage;
        }
        yield event;
      }
      await this.emitAfterModelResponse(request, undefined, undefined, streamUsage);
      await logModelCall({
        kind: "stream",
        callId,
        role: request.role,
        profile,
        request,
        streamEvents: events,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      await this.emitAfterModelResponse(request, undefined, error, streamUsage);
      await logModelCall({
        kind: "stream",
        callId,
        role: request.role,
        profile,
        request,
        streamEvents: events,
        error,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  private async *streamWithFallback(
    primaryProfile: ResolvedModelProfile,
    request: GenerateRequest,
  ): AsyncIterable<StreamEvent> {
    await this.emitRoute({
      role: request.role,
      selectedProfile: primaryProfile.profileName,
      selectedModel: primaryProfile.model,
      provider: primaryProfile.provider,
      strategy: "primary",
      reason: "primary profile (streaming path falls back if no events arrive)",
      resolvedOnPrimary: true,
    });

    const primary = this.client.stream(request, primaryProfile);
    let firstEvent: StreamEvent | undefined;
    const tail: StreamEvent[] = [];
    try {
      for await (const event of primary) {
        if (firstEvent === undefined) {
          firstEvent = event;
          yield event;
        } else {
          // Buffer the rest so we can replay it on the fallback path if
          // the primary fails later in the stream.
          tail.push(event);
        }
      }
      // Stream finished cleanly — replay the tail.
      for (const event of tail) yield event;
      return;
    } catch (error) {
      // The primary stream failed before completion. If we already
      // delivered events, we cannot transparently retry; surface the
      // error inline. If we never delivered an event, try the fallback
      // profile so the consumer still gets a response.
      if (firstEvent !== undefined) {
        throw error;
      }
    }

    const fallbackName = primaryProfile.fallbackProfile;
    if (!fallbackName) {
      throw new Error(
        `Primary streaming provider '${primaryProfile.provider}' failed and no fallback profile is configured.`,
      );
    }
    const fallbackProfile = resolveModelRole(this.config, fallbackName);
    if (fallbackProfile.profileName === primaryProfile.profileName) {
      throw new Error(
        `Primary streaming provider '${primaryProfile.provider}' failed and fallback profile '${fallbackName}' could not be resolved.`,
      );
    }
    await this.emitRoute({
      role: request.role,
      selectedProfile: fallbackProfile.profileName,
      selectedModel: fallbackProfile.model,
      provider: fallbackProfile.provider,
      strategy: "fallback",
      reason: `primary provider failed before first event; switched to fallback profile '${fallbackName}'`,
      resolvedOnPrimary: false,
    });
    for await (const event of this.client.stream(request, fallbackProfile)) {
      yield event;
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    assertRoleCapabilities(this.config, request.role);
    const profile = await this.resolveRole(request.role);
    if (!profile.capabilities.embeddings) {
      throw new Error(`Role '${request.role}' requires a profile with embeddings=true`);
    }
    const callId = nextCallId("active", "embed");
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    try {
      const result = await this.withFallback(profile, request.role, (resolvedProfile) => this.client.embed(request, resolvedProfile), "primary");
      await logModelCall({
        kind: "embed",
        callId,
        role: request.role,
        profile,
        request,
        response: result,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
      return result;
    } catch (error) {
      await logModelCall({
        kind: "embed",
        callId,
        role: request.role,
        profile,
        request,
        error,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
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

  private async emitBeforeModelRequest(request: GenerateRequest): Promise<void> {
    await this.lifecycleBus.emit({
      type: "before_model_request",
      role: request.role,
      source: request.source ?? "unknown",
      request,
    });
  }

  private async emitAfterModelResponse(
    request: GenerateRequest,
    response?: GenerateResult,
    error?: unknown,
    streamUsage?: unknown,
  ): Promise<void> {
    await this.lifecycleBus.emit({
      type: "after_model_response",
      role: request.role,
      source: request.source ?? "unknown",
      request,
      ...(response ? { response } : {}),
      ...(response?.usage !== undefined || streamUsage !== undefined ? { usage: response?.usage ?? streamUsage } : {}),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
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
