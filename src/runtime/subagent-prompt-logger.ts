/**
 * runtime/subagent-prompt-logger.ts — uniform helper that logs every
 * sub-agent prompt (system + user) to the trajectory. The user wants
 * visibility into what each sub-agent actually saw when it was
 * invoked, so we log:
 *   - the sub-agent name (e.g. "planner", "patcher", "swarm")
 *   - the role and model resolved for the call
 *   - the full system prompt
 *   - the full user prompt
 *
 * Secrets are redacted before write. The helper is intentionally
 * tiny so every sub-agent call site can adopt it without ceremony.
 */

import { randomUUID } from "node:crypto";
import type { TrajectoryLogger } from "../logging/trajectory.js";

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // sk-... keys (OpenAI/Anthropic/MiniMax style)
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "sk-***REDACTED***" },
  // sk-cp-... (claude proxy variant)
  { pattern: /\bsk-cp-[A-Za-z0-9_-]{16,}/g, replacement: "sk-cp-***REDACTED***" },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/g, replacement: "Bearer ***REDACTED***" },
  // Authorization headers (basic + bearer)
  { pattern: /[Aa]uthorization:\s*[^\n]+/g, replacement: "Authorization: ***REDACTED***" },
  // Generic api_key / api-key env values
  { pattern: /\b(api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/gi, replacement: "$1=***REDACTED***" },
];

export interface LogSubagentPromptInput {
  /** The sub-agent name (e.g. "planner_subagent", "patcher_subagent", "swarm"). */
  subagent: string;
  /** Resolved model role (e.g. "planner", "patcher"). */
  role?: string;
  /** Resolved model name (e.g. "MiniMax-M3"). */
  model?: string;
  /** Full system prompt sent to the model. */
  systemPrompt: string;
  /** Full user prompt sent to the model. */
  userPrompt: string;
  /** Optional call id (randomUUID if omitted). */
  callId?: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface SubagentPromptContext {
  trajectoryLogger: TrajectoryLogger;
  runId: string;
  sessionId: string;
  traceId: string;
}

/**
 * Log a single sub-agent invocation. Always writes — callers don't
 * need to gate. Failures are swallowed so logging never breaks the
 * underlying model call.
 */
export async function logSubagentPrompt(
  ctx: SubagentPromptContext,
  input: LogSubagentPromptInput,
): Promise<void> {
  try {
    await ctx.trajectoryLogger.write({
      event_id: randomUUID(),
      run_id: ctx.runId,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "subagent_prompt",
      level: "info",
      subagent: input.subagent,
      ...(input.role ? { role: input.role } : {}),
      ...(input.model ? { model: input.model } : {}),
      system_prompt: redact(input.systemPrompt),
      user_prompt: redact(input.userPrompt),
      user_prompt_chars: input.userPrompt.length,
      ...(input.callId ? { call_id: input.callId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  } catch {
    // Logging must never break a sub-agent call.
  }
}

/**
 * Convenience wrapper that resolves the role + model from the gateway
 * and logs the prompt in one step.
 */
export async function logSubagentPromptForCall(input: {
  ctx: SubagentPromptContext;
  subagent: string;
  systemPrompt: string;
  userPrompt: string;
  modelGateway?: {
    resolveRole(role: string): Promise<{ model: string; profileName: string }>;
  };
  role?: string;
  callId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  let model: string | undefined;
  if (input.modelGateway && input.role) {
    try {
      const resolved = await input.modelGateway.resolveRole(input.role);
      model = resolved.model;
    } catch {
      model = undefined;
    }
  }
  await logSubagentPrompt(input.ctx, {
    subagent: input.subagent,
    ...(input.role ? { role: input.role } : {}),
    ...(model ? { model } : {}),
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    ...(input.callId ? { callId: input.callId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}