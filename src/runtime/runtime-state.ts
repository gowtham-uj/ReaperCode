/**
 * Phase T3.11 Wave 3 — runtime-state helpers.
 *
 * Pure helpers for runtime event-factory + control-flow-splitting logic.
 * Extracted from engine.ts (Wave 3). Behavior must be identical except
 * the legacy hidden repair control-plane has been removed from the new
 * general-agent runtime.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentEventEnvelope, AgentRequestEnvelope, TransportKind } from "../connection/schemas.js";
import type { ToolCall } from "../tools/types.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import type { ReaperRunContext } from "./run-manager.js";
import type { RuntimeEngineResult, SplitToolCalls } from "./engine.js";

export function inferTransport(value: unknown): TransportKind {
  const allowed = new Set<TransportKind>(["stdio", "http_json", "http_sse", "websocket", "webhook"]);
  return typeof value === "string" && allowed.has(value as TransportKind) ? (value as TransportKind) : "stdio";
}

export async function persistRunResult(runContext: ReaperRunContext, result: RuntimeEngineResult, status: "completed" | "failed"): Promise<void> {
  await mkdir(runContext.runDir, { recursive: true });
  await writeFile(
    path.join(runContext.runDir, "result.json"),
    JSON.stringify(
      {
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        traceId: runContext.traceId,
        status,
        completedAt: new Date().toISOString(),
        assistantMessage: result.assistantMessage,
        toolResultCount: result.toolResults.length,
        failedToolResultCount: result.toolResults.filter((item) => !item.ok).length,
        verification: result.verification,
        trajectoryPath: result.trajectoryPath,
        contentFingerprint: result.contentFingerprint,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function extractIntentSummary(request: AgentRequestEnvelope): string {
  const prompt = typeof request.payload.prompt === "string" ? request.payload.prompt.trim() : "";
  return prompt ? prompt.slice(0, 200) : "Execute requested coding task";
}

export function makeEvent(request: AgentRequestEnvelope, messageType: AgentEventEnvelope["message_type"], payload: Record<string, unknown>): AgentEventEnvelope {
  return {
    connection_id: request.connection_id,
    session_id: request.session_id,
    turn_id: request.turn_id,
    request_id: request.request_id,
    message_type: messageType,
    timestamp: new Date().toISOString(),
    trace_id: request.trace_id,
    payload,
    metadata: {},
  };
}

export async function logAssistantMessageTrace(input: {
  trajectoryLogger: TrajectoryLogger;
  runId: string;
  sessionId: string;
  traceId: string;
  level: "info" | "debug" | "trace";
  source: string;
  content: string;
}): Promise<void> {
  const content = input.content.trim();
  if (!content) return;
  await input.trajectoryLogger.write({
    event_id: randomUUID(),
    run_id: input.runId,
    session_id: input.sessionId,
    trace_id: input.traceId,
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "assistant_message",
    level: input.level,
    content: `[${input.source}] ${content}`,
  });
}

export async function logModelResponseTrace(input: {
  trajectoryLogger: TrajectoryLogger;
  runId: string;
  sessionId: string;
  traceId: string;
  level: "info" | "debug" | "trace";
  source: string;
  assistantMessage: string;
  toolCalls: ToolCall[];
}): Promise<void> {
  await input.trajectoryLogger.write({
    event_id: randomUUID(),
    run_id: input.runId,
    session_id: input.sessionId,
    trace_id: input.traceId,
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    kind: "model_response",
    level: input.level,
    source: input.source,
    assistant_message: input.assistantMessage,
    tool_call_count: input.toolCalls.length,
    tool_calls: input.toolCalls.map((call) => ({ id: call.id, name: call.name })),
    has_completion_signal: input.toolCalls.some((call) => call.name === "complete_task"),
    has_advance_signal: input.toolCalls.some((call) => call.name === "advance_step"),
  });
}

export function splitControlToolCalls(toolCalls: ToolCall[]): SplitToolCalls {
  const executableToolCalls: ToolCall[] = [];
  const advisoryToolCalls: Array<Extract<ToolCall, { name: "update_plan" | "update_todo" }>> = [];
  let completionSignal: Extract<ToolCall, { name: "complete_task" }> | undefined;
  let advancementSignal: Extract<ToolCall, { name: "advance_step" }> | undefined;

  for (const call of toolCalls) {
    if (call.name === "update_plan" || call.name === "update_todo") {
      advisoryToolCalls.push(call);
      continue;
    }
    if (call.name === "complete_task") {
      completionSignal = call;
      break;
    }
    if (call.name === "advance_step") {
      advancementSignal = call;
      continue;
    }
    executableToolCalls.push(call);
  }

  return {
    executableToolCalls,
    ...(advisoryToolCalls.length ? { advisoryToolCalls } : {}),
    ...(completionSignal ? { completionSignal } : {}),
    ...(advancementSignal ? { advancementSignal } : {}),
  };
}

// Phase T3.11: file-hint helpers moved to ./file-hints.ts
