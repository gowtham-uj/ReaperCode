/**
 * Phase T2.6: router-decision -> trajectory adapter.
 *
 * `ConfiguredModelGateway` emits a `RouterDecisionEvent` for every model
 * call via its `onRoute` option. This module turns that event into a
 * structured `router_decision` trajectory entry that the
 * `TrajectoryLogger` can persist.
 */

import { randomUUID } from "node:crypto";
import type { RouterDecisionEvent } from "./gateway.js";
import type { TrajectoryLogger } from "../logging/trajectory.js";

export interface RouterTelemetryContext {
  runId: string;
  sessionId: string;
  traceId: string;
  level?: "info" | "debug" | "trace";
}

export interface RouterTelemetryOptions {
  logger: TrajectoryLogger;
  context: RouterTelemetryContext;
}

export function createRouterTelemetryCallback(options: RouterTelemetryOptions): (event: RouterDecisionEvent) => void | Promise<void> {
  return async (event) => {
    await options.logger.write({
      event_id: randomUUID(),
      run_id: options.context.runId,
      session_id: options.context.sessionId,
      trace_id: options.context.traceId,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "router_decision",
      level: options.context.level ?? "info",
      role: event.role,
      selected_profile: event.selectedProfile,
      selected_model: event.selectedModel,
      provider: event.provider,
      strategy: event.strategy,
      reason: event.reason,
      latency_ms: event.latencyMs,
      resolved_on_primary: event.resolvedOnPrimary,
    });
  };
}
