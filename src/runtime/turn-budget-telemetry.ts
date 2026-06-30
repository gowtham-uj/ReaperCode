/**
 * Phase T2.7: per-turn token-budget telemetry helper.
 *
 * Owns a `TokenBudgetTracker`, records usage from each model-response,
 * and writes `token_budget` trajectory entries at the end of each turn.
 */

import { randomUUID } from "node:crypto";
import { TokenBudgetTracker, tokenUsageFromResponse, type TokenUsage } from "../context/token-budget.js";
import type { TrajectoryLogger } from "../logging/trajectory.js";

export interface TurnBudgetTelemetryContext {
  runId: string;
  sessionId: string;
  traceId: string;
  level?: "info" | "debug" | "trace";
  source?: string;
}

export interface TurnBudgetTelemetryOptions {
  logger: TrajectoryLogger;
  context: TurnBudgetTelemetryContext;
}

export class TurnBudgetTelemetry {
  private readonly tracker = new TokenBudgetTracker();
  private readonly logger: TrajectoryLogger;
  private readonly context: TurnBudgetTelemetryContext;

  constructor(options: TurnBudgetTelemetryOptions) {
    this.logger = options.logger;
    this.context = options.context;
  }

  beginTurn(): void {
    this.tracker.beginTurn();
  }

  recordUsage(usage: TokenUsage | undefined | null): void {
    this.tracker.record(usage);
  }

  /**
   * Convenience helper: extract the standard usage shape out of a
   * raw provider response object and record it.
   */
  recordResponse(response: { usage?: unknown } | null | undefined): void {
    if (!response) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.recordUsage(tokenUsageFromResponse(response as any));
  }

  async emitSnapshot(): Promise<void> {
    const snap = this.tracker.snapshot();
    await this.logger.write({
      event_id: randomUUID(),
      run_id: this.context.runId,
      session_id: this.context.sessionId,
      trace_id: this.context.traceId,
      timestamp: snap.takenAt,
      log_schema_version: 1,
      kind: "token_budget",
      level: this.context.level ?? "info",
      source: this.context.source ?? "runtime",
      turn_input_tokens: snap.inputTokens,
      turn_output_tokens: snap.outputTokens,
      turn_cache_read_tokens: snap.cacheReadTokens,
      turn_cache_write_tokens: snap.cacheWriteTokens,
      turn_call_count: snap.callCount,
      cumulative_input_tokens: snap.cumulativeInputTokens,
      cumulative_output_tokens: snap.cumulativeOutputTokens,
      cumulative_cache_read_tokens: snap.cumulativeCacheReadTokens,
      cumulative_cache_write_tokens: snap.cumulativeCacheWriteTokens,
      cumulative_call_count: snap.cumulativeCallCount,
    });
  }
}
