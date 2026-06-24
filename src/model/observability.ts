import { randomUUID } from "node:crypto";
import { logLangfuseEvent } from "../logging/langfuse.js";
import { displayModelProfile, getLegacyModelRole, resolveModelRoleAlias } from "./types.js";

export interface ModelCallRecord {
  role: string;
  source?: string;
  profile?: string;
  legacyRole?: string;
  provider: string;
  model: string;
  maxTokens: number | undefined;
  responseFormat: "json" | "text" | undefined;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  promptChars: number;
  responseChars: number;
  responseFinishReason: string | undefined;
  finishReason?: string;
  responseContentChars: number;
  truncated: boolean;
  attempt: number;
  systemChars?: number;
  toolCallCount?: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface ModelCallContext {
  workspaceRoot: string;
  runId: string;
  sessionId?: string;
  traceId?: string;
  source: string;
  callId: string;
  promptPreview: string;
  system?: string;
}

let activeStack: ModelCallContext[] = [];

export function pushModelCallContext(ctx: ModelCallContext): () => void {
  activeStack.push(ctx);
  return () => {
    const idx = activeStack.lastIndexOf(ctx);
    if (idx >= 0) activeStack.splice(idx, 1);
  };
}

export function getActiveModelCallContext(): ModelCallContext | undefined {
  return activeStack.length ? activeStack[activeStack.length - 1] : undefined;
}

export async function recordModelCall(record: ModelCallRecord, messages: Array<{ role: string; content: string }>, response: { content: string; finishReason?: string; toolCalls?: unknown[] }): Promise<void> {
  const ctx = getActiveModelCallContext();
  if (!ctx) return;
  const source = record.source ?? ctx.source;
  const canonicalRole = resolveModelRoleAlias(record.role);
  const profile = record.profile ?? displayModelProfile(record.role);
  const legacyRole = record.legacyRole ?? (canonicalRole ? getLegacyModelRole(canonicalRole) : undefined);
  const systemChars = record.systemChars ?? ctx.system?.length;
  const responseFinishReason = record.responseFinishReason ?? response.finishReason;
  const finishReason = record.finishReason ?? responseFinishReason;
  const toolCallCount = record.toolCallCount ?? response.toolCalls?.length;
  const promptText = messages
    .map((message) => `[${message.role}] ${message.content}`)
    .join("\n\n---\n\n");
  try {
    await logLangfuseEvent({
      workspaceRoot: ctx.workspaceRoot,
      name: "reaper.model_request",
      type: "generation",
      trace: {
        runId: ctx.runId,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      },
      metadata: {
        source,
        profile,
        legacyRole: legacyRole ?? null,
        role: legacyRole ?? record.role,
        callId: ctx.callId,
        provider: record.provider,
        model: record.model,
        maxTokens: record.maxTokens ?? null,
        responseFormat: record.responseFormat ?? null,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: record.durationMs,
        promptChars: record.promptChars,
        systemChars: systemChars ?? null,
        responseChars: record.responseChars,
        responseContentChars: record.responseContentChars,
        finishReason: finishReason ?? null,
        responseFinishReason: responseFinishReason ?? null,
        truncated: record.truncated,
        attempt: record.attempt,
        toolCallCount: toolCallCount ?? null,
        usage: record.usage,
        callSiteSource: ctx.source ?? null,
      },
      input: {
        prompt: promptText,
        promptPreview: ctx.promptPreview,
        ...(ctx.system ? { system: ctx.system, systemChars: ctx.system.length } : {}),
      },
      output: {
        content: response.content,
        finishReason: response.finishReason ?? null,
      },
    });
  } catch {
    /* recorder is best-effort */
  }
}

export function newModelCallId(): string {
  return randomUUID();
}
