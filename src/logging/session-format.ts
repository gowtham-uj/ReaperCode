/**
 * Session log format.
 *
 * On disk this is a mutation stream:
 *   header (version 4)
 *   then { kind: entry | record | lane | fact, seq, timestamp, ... }
 *
 * Reaper still produces TrajectoryEntry objects in-process (engine,
 * executor, wiring). This module maps those onto session mutations so
 * a harness can tail one file. Reaper-only kinds land as typed
 * `custom` entries and stay Zod-checked on write.
 */

import { z } from "zod";
import type { TrajectoryEntry } from "./schema.js";

export const SESSION_LOG_VERSION = 4 as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SessionHeader {
  kind: "header";
  version: 4;
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  metadata?: Record<string, JsonValue>;
}

export type SessionEntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "active_tools_change"
  | "compaction"
  | "branch_summary"
  | "custom";

export interface SessionEntryBase {
  kind: "entry";
  type: SessionEntryType;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
  lane?: string;
}

export interface CustomSessionEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CompactionSessionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  retainedTail: unknown[];
  tokensBefore: number;
  details?: unknown;
}

export interface ModelChangeSessionEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface MessageSessionEntry extends SessionEntryBase {
  type: "message";
  message: unknown;
}

export type SessionEntry =
  | CustomSessionEntry
  | CompactionSessionEntry
  | ModelChangeSessionEntry
  | MessageSessionEntry
  | (SessionEntryBase & { type: Exclude<SessionEntryType, "custom" | "compaction" | "model_change" | "message"> });

export type SessionRecordType =
  | "operation_started"
  | "abort_requested"
  | "operation_finished"
  | "step_attempt"
  | "tool_started"
  | "queue_enqueued"
  | "queue_cancelled"
  | "write_deferred"
  | "usage";

export interface SessionRecordBase {
  kind: "record";
  type: SessionRecordType;
  id: string;
  seq: number;
  lane: string;
  timestamp: number;
}

export type SessionRecord = SessionRecordBase & Record<string, unknown>;

export interface SessionLaneMutation {
  kind: "lane";
  seq: number;
  lane: string;
  leafId: string | null;
}

export type SessionFactMutation =
  | { kind: "fact"; seq: number; fact: "name"; name?: string }
  | { kind: "fact"; seq: number; fact: "label"; targetId: string; label?: string };

export type SessionMutation = SessionEntry | SessionRecord | SessionLaneMutation | SessionFactMutation;

export const SessionHeaderSchema = z
  .object({
    kind: z.literal("header"),
    version: z.literal(4),
    id: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    cwd: z.string().min(1),
    parentSessionId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export function isSessionHeader(value: unknown): value is SessionHeader {
  return SessionHeaderSchema.safeParse(value).success;
}

export function isSessionMutation(value: unknown): value is SessionMutation {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "entry" || kind === "record" || kind === "lane" || kind === "fact";
}

export interface SessionClock {
  nextSeq(): number;
  nowMs(): number;
  nextId(): string;
}

export function createSessionClock(start?: { seq?: number; ids?: number }): SessionClock {
  let seq = start?.seq ?? 0;
  let ids = start?.ids ?? 0;
  return {
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    nowMs: () => Date.now(),
    nextId: () => {
      ids += 1;
      return `e${ids.toString(36)}`;
    },
  };
}

function restOf(entry: TrajectoryEntry): Record<string, unknown> {
  const {
    event_id: _e,
    run_id: _r,
    session_id: _s,
    trace_id: _t,
    timestamp: _ts,
    log_schema_version: _v,
    kind: _k,
    level: _l,
    ...rest
  } = entry as TrajectoryEntry & Record<string, unknown>;
  return rest;
}

/**
 * Map one in-process trajectory event onto one or more session mutations.
 * Seq / timestamp / parentId are filled by the writer.
 */
export function mapTrajectoryToMutations(
  entry: TrajectoryEntry,
  clock: SessionClock,
  ctx: { lane: string; leafId: string | null; runId: string },
): SessionMutation[] {
  const seq = () => clock.nextSeq();
  const ts = () => clock.nowMs();
  const id = () => entry.event_id || clock.nextId();
  const lane = ctx.lane;
  const parentId = ctx.leafId;
  const data = restOf(entry);

  const custom = (customType: string, extra?: Record<string, unknown>): CustomSessionEntry => ({
    kind: "entry",
    type: "custom",
    customType,
    id: id(),
    seq: seq(),
    parentId,
    timestamp: ts(),
    lane,
    data: extra ?? data,
  });

  switch (entry.kind) {
    case "session_start":
      return [
        {
          kind: "record",
          type: "operation_started",
          id: id(),
          seq: seq(),
          lane,
          timestamp: ts(),
          sourceLeafId: parentId,
          intent: {
            kind: "run",
            originalPrompt: [],
            initialMessages: [],
          },
          runId: ctx.runId,
          provider: entry.provider,
          model: entry.model,
          run_params: entry.run_params,
          user_intent_summary: entry.user_intent_summary,
        },
      ];
    case "run_end":
      return [
        {
          kind: "record",
          type: "operation_finished",
          id: id(),
          seq: seq(),
          lane,
          timestamp: ts(),
          runId: ctx.runId,
          outcome: entry.status === "completed" ? "completed" : entry.status === "aborted" ? "aborted" : "failed",
          final_assistant_message: entry.final_assistant_message,
          duration_ms: entry.duration_ms,
        },
      ];
    case "tool_call":
      if (entry.status === "started") {
        return [
          {
            kind: "record",
            type: "tool_started",
            id: id(),
            seq: seq(),
            lane,
            timestamp: ts(),
            runId: ctx.runId,
            assistantEntryId: parentId ?? "",
            toolIndex: 0,
            toolCallId: entry.decision_id,
            toolName: entry.tool_name,
            effectiveArgs: (entry.args && typeof entry.args === "object" ? entry.args : {}) as Record<string, unknown>,
            resultEntryId: entry.decision_id,
            replay: "never",
            turn_index: entry.turn_index,
            duration_ms: entry.duration_ms,
            is_error: entry.is_error,
          },
        ];
      }
      return [
        {
          kind: "entry",
          type: "message",
          id: id(),
          seq: seq(),
          parentId,
          timestamp: ts(),
          lane,
          message: {
            role: "tool",
            tool_call_id: entry.decision_id,
            name: entry.tool_name,
            content: entry.error ?? entry.output ?? "",
            is_error: entry.is_error ?? entry.status === "failed",
            duration_ms: entry.duration_ms,
            turn_index: entry.turn_index,
            status: entry.status,
          },
        },
      ];
    case "thinking":
      return [
        {
          kind: "entry",
          type: "message",
          id: id(),
          seq: seq(),
          parentId,
          timestamp: ts(),
          lane,
          message: { role: "thinking", content: entry.content, turn_index: entry.turn_index },
        },
        custom("thinking", { content: entry.content, turn_index: entry.turn_index, streaming: entry.streaming }),
      ];

    case "promoted_context_model":
      return [
        {
          kind: "entry",
          type: "model_change",
          id: id(),
          seq: seq(),
          parentId,
          timestamp: ts(),
          lane,
          provider: "reaper",
          modelId: entry.to_profile,
          from_role: entry.from_role,
          from_profile: entry.from_profile,
          to_role: entry.to_role,
          to_context_tokens: entry.to_context_tokens,
        } as SessionMutation,
      ];
    case "full_summary":
    case "handoff_summary":
      return [
        {
          kind: "entry",
          type: "compaction",
          id: id(),
          seq: seq(),
          parentId,
          timestamp: ts(),
          lane,
          summary: `${entry.kind} chars=${entry.summary_chars ?? 0} saved=${entry.saved_chars ?? 0}`,
          retainedTail: [],
          tokensBefore: entry.kept_messages ?? 0,
          details: data,
        },
        custom(entry.kind, data),
      ];
    case "context_shake":
    case "bash_head_tail":
    case "time_microcompact":
    case "ptl_recovery":
    case "idle_compaction":
    case "incomplete_recovery":
    case "snapcompact":
    case "verification_summary":
    case "recovery_summary":
    case "policy_decision":
      return [custom(entry.kind, data)];
    case "token_budget":
      return [
        {
          kind: "record",
          type: "usage",
          id: id(),
          seq: seq(),
          lane,
          timestamp: ts(),
          cause: "assistant",
          runId: ctx.runId,
          entryId: parentId ?? id(),
          attempt: 1,
          stopReason: "stop",
          usage: {
            input: entry.turn_input_tokens,
            output: entry.turn_output_tokens,
            cacheRead: entry.turn_cache_read_tokens,
            cacheWrite: entry.turn_cache_write_tokens,
            total: entry.turn_input_tokens + entry.turn_output_tokens,
          },
          cumulative: {
            input: entry.cumulative_input_tokens,
            output: entry.cumulative_output_tokens,
            cacheRead: entry.cumulative_cache_read_tokens,
            cacheWrite: entry.cumulative_cache_write_tokens,
          },
          cost_usd: entry.cost_usd,
          turn_reasoning_tokens: entry.turn_reasoning_tokens,
          turn_index: entry.turn_index,
        },
      ];
    case "assistant_message":
      return [
        {
          kind: "entry",
          type: "message",
          id: id(),
          seq: seq(),
          parentId,
          timestamp: ts(),
          lane,
          message: {
            role: "assistant",
            content: entry.content,
            turn_index: entry.turn_index,
            ...(entry.tool_names?.length ? { tool_names: entry.tool_names } : {}),
          },
        },
      ];
    default:
      return [custom(entry.kind, data)];
  }
}

export function buildSessionHeader(input: {
  id: string;
  cwd: string;
  createdAt?: number;
  metadata?: Record<string, JsonValue>;
}): SessionHeader {
  return {
    kind: "header",
    version: SESSION_LOG_VERSION,
    id: input.id,
    createdAt: input.createdAt ?? Date.now(),
    cwd: input.cwd,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/** Reaper-only customTypes layered on the `custom` entry. */
export const ReaperCustomTypeSchema = z.enum([
  "thinking",
  "tool_end",
  "state_transition",
  "policy_decision",
  "verification_summary",
  "recovery_summary",
  "agent_step",
  "model_response",
  "step_analysis",
  "session_metrics",
  "subagent_prompt",
  "engine_turn_complete",
  "context_shake",
  "bash_head_tail",
  "time_microcompact",
  "ptl_recovery",
  "idle_compaction",
  "incomplete_recovery",
  "snapcompact",
  "full_summary",
  "handoff_summary",
  "router_decision",
  "empty_stop_retry",
  "unexpected_stop_retry",
  "premature_stop_nudge",
  "tool_call_parse_error",
  "hook_error",
  "audit",
]);

const SeqTs = {
  seq: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
};

export const SessionEntrySchema = z
  .object({
    kind: z.literal("entry"),
    type: z.enum([
      "message",
      "model_change",
      "thinking_level_change",
      "active_tools_change",
      "compaction",
      "branch_summary",
      "custom",
    ]),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    lane: z.string().optional(),
    customType: z.string().min(1).optional(),
    data: z.unknown().optional(),
    ...SeqTs,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.type === "custom") {
      const parsed = ReaperCustomTypeSchema.safeParse(value.customType);
      if (!value.customType) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "custom entry requires customType" });
      } else if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown Reaper customType ${value.customType}`,
        });
      }
    }
  });

export const SessionRecordSchema = z
  .object({
    kind: z.literal("record"),
    type: z.enum([
      "operation_started",
      "abort_requested",
      "operation_finished",
      "step_attempt",
      "tool_started",
      "queue_enqueued",
      "queue_cancelled",
      "write_deferred",
      "usage",
    ]),
    id: z.string().min(1),
    lane: z.string().min(1),
    ...SeqTs,
  })
  .passthrough();

export const SessionLaneSchema = z.object({
  kind: z.literal("lane"),
  lane: z.string().min(1),
  leafId: z.string().nullable(),
  seq: z.number().int().positive(),
});

export const SessionFactSchema = z.discriminatedUnion("fact", [
  z.object({ kind: z.literal("fact"), seq: z.number().int().positive(), fact: z.literal("name"), name: z.string().optional() }),
  z.object({
    kind: z.literal("fact"),
    seq: z.number().int().positive(),
    fact: z.literal("label"),
    targetId: z.string().min(1),
    label: z.string().optional(),
  }),
]);

export const SessionMutationSchema = z.union([
  SessionEntrySchema,
  SessionRecordSchema,
  SessionLaneSchema,
  SessionFactSchema,
]);

export const SessionLineSchema = z.union([SessionHeaderSchema, SessionMutationSchema]);

export function parseSessionLine(input: unknown): SessionHeader | SessionMutation {
  return SessionLineSchema.parse(input) as SessionHeader | SessionMutation;
}
