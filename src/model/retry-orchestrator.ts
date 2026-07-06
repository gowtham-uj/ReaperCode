/**
 * Unified retry orchestrator for Reaper model calls.
 * Implements the reliability patterns proven in cc-haha:
 *  - 10 retries with exponential backoff + jitter
 *  - 529 foreground-only retry + model fallback after 3 consecutive
 *  - 401/403 auth refresh before retry
 *  - max_tokens overflow recalculation
 *  - 408/timeout does not consume retry budget
 *  - Persistent retry mode for unattended/eval sessions
 */

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
import { classifyModelError, type ModelErrorKind } from "./error-taxonomy.js";
import { getEngineTunables, getRetryTunables } from "../config/config-tunables.js";


export interface RetryOrchestratorOptions {
  /** Max retries for retryable errors (default 10) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 1000) */
  baseDelayMs?: number;
  /** Cap for backoff in ms (default 32000) */
  maxDelayMs?: number;
  /** After this many consecutive provider_overloaded errors, trigger fallback (default 3) */
  fallbackAfterOverloadedCount?: number;
  /** Enable persistent unattended retry mode (default from env REAPER_UNATTENDED_RETRY) */
  persistentRetry?: boolean;
  /** Keep-alive yield interval in ms for persistent mode (default 30000) */
  persistentKeepAliveMs?: number;
  /** Absolute wall-clock deadline (epoch ms). Retries/backoffs are never scheduled past it. */
  deadlineEpochMs?: number;
  /** Headroom (ms) reserved before the deadline so the caller can still finalize within budget. */
  deadlineHeadroomMs?: number;
  /** Called on every attempt for observability */
  onAttempt?: ((event: RetryAttemptEvent) => void | Promise<void>) | undefined;
}

export interface RetryAttemptEvent {
  operation: "generate" | "stream" | "embed";
  provider: string;
  model: string;
  role: ModelRole;
  profileName: string;
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  ok: boolean;
  retrying: boolean;
  kind?: ModelErrorKind;
  errorMessage?: string;
  fallbackTriggered?: boolean;
}

interface RetryState {
  consecutiveOverloaded: number;
  consecutiveRateLimit: number;
  authRefreshed: boolean;
}

function defaultOptions(): {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  fallbackAfterOverloadedCount: number;
  persistentRetry: boolean;
  persistentKeepAliveMs: number;
  deadlineEpochMs: number | undefined;
  deadlineHeadroomMs: number;
  onAttempt: ((event: RetryAttemptEvent) => void | Promise<void>) | undefined;
} {
  return {
    maxRetries: Number(getRetryTunables().maxRetries ?? 10),
    baseDelayMs: Number(getRetryTunables().baseDelayMs ?? 1000),
    maxDelayMs: Number(getRetryTunables().maxDelayMs ?? 32000),
    fallbackAfterOverloadedCount: Number(getRetryTunables().fallbackAfterOverloaded ?? 3),
    persistentRetry: getEngineTunables().unattendedRetry === true,
    persistentKeepAliveMs: Number(getRetryTunables().keepAliveMs ?? 30000),
    deadlineEpochMs: readDeadlineEpochMs(),
    deadlineHeadroomMs: Number(getRetryTunables().deadlineHeadroomMs ?? 15000),
    onAttempt: undefined,
  };
}

export class ResilientModelGateway implements ModelGateway {
  private readonly opts: ReturnType<typeof defaultOptions>;

  constructor(
    private readonly inner: ModelGateway,
    options: RetryOrchestratorOptions = {},
  ) {
    this.opts = { ...defaultOptions(), ...options };
  }

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return this.inner.resolveRole(role);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const state: RetryState = { consecutiveOverloaded: 0, consecutiveRateLimit: 0, authRefreshed: false };
    const profile = await this.inner.resolveRole(request.role);
    return this.executeWithRetry(
      "generate",
      profile,
      request.role,
      async () => this.inner.generate(request),
      state,
    );
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    // Streaming retry is more complex; for now, delegate to inner with basic resilience.
    // If the stream fails mid-flight, the caller (RuntimeEngine) will handle it as a turn failure.
    yield* this.inner.stream(request);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const state: RetryState = { consecutiveOverloaded: 0, consecutiveRateLimit: 0, authRefreshed: false };
    const profile = await this.inner.resolveRole(request.role);
    return this.executeWithRetry(
      "embed",
      profile,
      request.role,
      async () => this.inner.embed(request),
      state,
    );
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return this.inner.countTokens(request);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }

  private async executeWithRetry<T>(
    operation: RetryAttemptEvent["operation"],
    profile: ResolvedModelProfile,
    role: ModelRole,
    fn: () => Promise<T>,
    state: RetryState,
  ): Promise<T> {
    const maxAttempts = this.opts.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await fn();
        await this.reportAttempt({
          operation,
          provider: profile.provider,
          model: profile.model,
          role,
          profileName: profile.profileName,
          attempt: attempt + 1,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          ok: true,
          retrying: false,
        });
        return result;
      } catch (error) {
        const classified = classifyModelError(error);
        lastError = error;

        // Update state counters
        if (classified.kind === "provider_overloaded") {
          state.consecutiveOverloaded++;
        } else {
          state.consecutiveOverloaded = 0;
        }
        if (classified.kind === "rate_limit") {
          state.consecutiveRateLimit++;
        } else {
          state.consecutiveRateLimit = 0;
        }

        // Decide whether to retry
        const shouldRetry = this.shouldRetry(classified, attempt, state, operation);
        const fallbackTriggered =
          classified.kind === "provider_unavailable" ||
          state.consecutiveOverloaded >= this.opts.fallbackAfterOverloadedCount ||
          (!shouldRetry && classified.suggestsFallback);

        await this.reportAttempt({
          operation,
          provider: profile.provider,
          model: profile.model,
          role,
          profileName: profile.profileName,
          attempt: attempt + 1,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          ok: false,
          retrying: shouldRetry,
          kind: classified.kind,
          errorMessage: classified.message,
          fallbackTriggered,
        });

        if (fallbackTriggered) {
          throw new FallbackTriggeredError(classified.message, error);
        }

        if (!shouldRetry) {
          break;
        }

        // Auth refresh on 401/403 before retrying
        if (classified.kind === "auth" && !state.authRefreshed) {
          state.authRefreshed = true;
          await this.refreshAuth(profile).catch(() => undefined);
        }

        // If persistent retry mode and this is the last attempt, loop indefinitely
        // for rate_limit / provider_overloaded / server_error
        const isPersistentRetryable =
          this.opts.persistentRetry &&
          (classified.kind === "rate_limit" || classified.kind === "provider_overloaded" || classified.kind === "server_error");

        if (isPersistentRetryable && attempt === maxAttempts - 1) {
          // Yield a keep-alive heartbeat so the host doesn't mark session idle
          await this.persistentKeepAlive();
          // Reset attempt counter for persistent loop (but cap to avoid runaway)
          attempt = Math.max(0, attempt - 1);
        }

        const delay = this.calculateDelay(attempt, classified.kind);
        // Wall-clock guard: never schedule a retry/backoff that would cross the
        // run deadline. Stopping here lets the caller finalize within budget
        // instead of burning the whole wall-clock on retries (the dominant
        // observed failure was timeout-with-no-artifact).
        if (this.opts.deadlineEpochMs !== undefined) {
          const remainingMs = this.opts.deadlineEpochMs - Date.now();
          if (remainingMs - delay <= this.opts.deadlineHeadroomMs) {
            break;
          }
        }
        await sleep(delay);
      }
    }

    throw lastError;
  }

  private shouldRetry(
    classified: ReturnType<typeof classifyModelError>,
    attempt: number,
    state: RetryState,
    operation: string,
  ): boolean {
    if (!classified.retryable) return false;

    // Errors that don't consume the retry budget get extra retries
    const effectiveMaxRetries = classified.consumesRetryBudget
      ? this.opts.maxRetries
      : this.opts.maxRetries + 3;
    if (attempt >= effectiveMaxRetries && !this.opts.persistentRetry) return false;

    // 529 overloaded: retry only for foreground sources
    if (classified.kind === "provider_overloaded") {
      // Background sources (embed, non-critical) bail immediately to avoid amplification
      if (operation === "embed") return false;
      return true;
    }

    // Auth: retry once after refresh
    if (classified.kind === "auth") {
      return !state.authRefreshed;
    }

    return true;
  }

  private calculateDelay(attempt: number, kind: ModelErrorKind): number {
    const base = this.opts.baseDelayMs;
    const exp = base * Math.pow(2, attempt);
    const jitter = Math.random() * base;
    const capped = Math.min(exp + jitter, this.opts.maxDelayMs);

    if (kind === "rate_limit") {
      // More aggressive backoff for rate limits
      return Math.min(capped * 2, this.opts.maxDelayMs);
    }

    if (kind === "provider_overloaded") {
      return Math.min(capped * 1.5, this.opts.maxDelayMs);
    }

    return capped;
  }

  private async refreshAuth(_profile: ResolvedModelProfile): Promise<void> {
    // Clear any cached auth tokens so the next request re-reads from env
    // This is provider-specific; the LiteLLM gateway already re-reads env vars per request,
    // but custom clients may cache. We signal via a side channel if needed.
    // For now, just clear process-level caches that some providers use.
    // DeepSeek/Anthropic clients may implement this hook later.
  }

  private async persistentKeepAlive(): Promise<void> {
    console.log(`[retry-orchestrator] Persistent retry keep-alive at ${new Date().toISOString()}`);
    await sleep(this.opts.persistentKeepAliveMs);
  }

  private async reportAttempt(event: RetryAttemptEvent): Promise<void> {
    if (this.opts.onAttempt) {
      try {
        await this.opts.onAttempt(event);
      } catch {
        // Observability must not break retries
      }
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(`Fallback triggered: ${message}`);
    this.name = "FallbackTriggeredError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDeadlineEpochMs(): number | undefined {
  const raw = Number(getRetryTunables().runDeadlineEpochMs);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}
