import { z } from "zod";

const IsoDateTimeSchema = z.string().datetime({ offset: true });

const CommonLogFieldsSchema = z
  .object({
    event_id: z.string().min(1),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    trace_id: z.string().min(1),
    timestamp: IsoDateTimeSchema,
    log_schema_version: z.literal(1),
  })
  .strict();

export const TrajectoryEntrySchema = z.discriminatedUnion("kind", [
  CommonLogFieldsSchema.extend({
    kind: z.literal("session_start"),
    level: z.enum(["info", "debug", "trace"]),
    user_intent_summary: z.string().min(1),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("tool_call"),
    level: z.enum(["info", "debug", "trace"]),
    tool_name: z.string().min(1),
    decision_id: z.string().min(1),
    status: z.enum(["started", "completed", "failed"]),
    args: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("state_transition"),
    level: z.enum(["info", "debug", "trace"]),
    from_step: z.string().min(1),
    to_step: z.string().min(1),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("policy_decision"),
    level: z.enum(["info", "debug", "trace"]),
    decision_id: z.string().min(1),
    policy_id: z.string().min(1),
    outcome: z.enum(["allow", "deny", "skip"]),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("verification_summary"),
    level: z.enum(["info", "debug", "trace"]),
    attempt_count: z.number().int().min(0),
    pass_fail: z.enum(["pass", "fail"]),
    lite_verified: z.boolean(),
    score: z.number().optional(),
    score_source: z.string().min(1).optional(),
    score_threshold: z.number().optional(),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("recovery_summary"),
    level: z.enum(["info", "debug", "trace"]),
    recovery_type: z.enum(["wal_rollback", "shadow_restore", "retry", "manual_intervention"]),
    cause: z.string().min(1),
    outcome: z.enum(["success", "failure", "merge_conflict"]),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("agent_step"),
    level: z.enum(["info", "debug", "trace"]),
    step_id: z.string().min(1),
    step_title: z.string().min(1),
    instructions: z.string().min(1),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("assistant_message"),
    level: z.enum(["info", "debug", "trace"]),
    content: z.string().min(1),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("model_response"),
    level: z.enum(["info", "debug", "trace"]),
    source: z.string().min(1),
    assistant_message: z.string(),
    tool_call_count: z.number().int().min(0),
    tool_calls: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
      }),
    ),
    has_completion_signal: z.boolean(),
    has_advance_signal: z.boolean(),
  }),
  CommonLogFieldsSchema.extend({
    kind: z.literal("step_analysis"),
    level: z.enum(["info", "debug", "trace"]),
    analysis: z.string().min(1),
    is_task_aligned: z.boolean(),
    is_step_completed: z.boolean().optional(),
    remaining_gaps: z.array(z.string()).optional(),
  }),
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("session_metrics"),
	    level: z.enum(["info", "debug", "trace"]),
	    tool_count: z.number().int().min(0),
	    failure_count: z.number().int().min(0),
	    verification_attempts: z.number().int().min(0),
	    total_runtime_ms: z.number().int().min(0),
	    total_tool_calls: z.number().int().min(0).optional(),
	    max_action_repeat: z.number().int().min(0).optional(),
	    no_progress_trips: z.number().int().min(0).optional(),
	    completion_gate_attempts: z.number().int().min(0).optional(),
	    verified_completion: z.boolean().optional(),
	    stop_reason: z.enum(["solved", "no_progress_stop", "gate_exhausted", "harness_timeout", "infra_failed", "error"]).optional(),
	  }),
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("subagent_prompt"),
	    level: z.enum(["info", "debug", "trace"]),
	    subagent: z.string().min(1),
	    role: z.string().optional(),
	    model: z.string().optional(),
	    system_prompt: z.string(),
	    user_prompt: z.string(),
	    user_prompt_chars: z.number().int().min(0),
	    call_id: z.string().min(1).optional(),
	    metadata: z.record(z.string(), z.unknown()).optional(),
	  }),
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("engine_turn_complete"),
	    level: z.enum(["info", "debug", "trace"]),
	    source: z.string().min(1),
	    assistant_message: z.string(),
	    implicit: z.boolean(),
	    tool_result_count: z.number().int().min(0),
	    tool_results: z.array(
	      z.object({
	        name: z.string().min(1),
	        ok: z.boolean(),
	      }),
	    ),
	  }),
	  // Phase T2.7: per-turn + cumulative token accounting. Emitted at the
	  // end of every model turn (after `engine_turn_complete` if both fire,
	  // before the next turn's `beginTurn`). `cumulative_*` fields are the
	  // running totals across the whole run; the unprefixed fields are the
	  // delta for the just-finished turn. `taken_at` mirrors CommonLogFields'
	  // timestamp but is duplicated here so downstream consumers (langfuse,
	  // cost dashboards) can index without joining.
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("token_budget"),
	    level: z.enum(["info", "debug", "trace"]),
	    turn_input_tokens: z.number().int().min(0),
	    turn_output_tokens: z.number().int().min(0),
	    turn_cache_read_tokens: z.number().int().min(0),
	    turn_cache_write_tokens: z.number().int().min(0),
	    turn_call_count: z.number().int().min(0),
	    cumulative_input_tokens: z.number().int().min(0),
	    cumulative_output_tokens: z.number().int().min(0),
	    cumulative_cache_read_tokens: z.number().int().min(0),
	    cumulative_cache_write_tokens: z.number().int().min(0),
	    cumulative_call_count: z.number().int().min(0),
	    source: z.string().min(1).optional(),
	  }),
	  // Phase T2.6: structured router-decision telemetry. Emitted once per
	  // model call by `ConfiguredModelGateway.onRoute` (and any future
	  // SmartRouter wiring). Captures which profile+strategy the gateway
	  // resolved on, why, and how long the call took. `resolved_on_primary`
	  // distinguishes a clean primary hit from a fallback recovery path so
	  // dashboards can show the fallback rate without parsing `reason`.
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("router_decision"),
	    level: z.enum(["info", "debug", "trace"]),
	    role: z.string().min(1),
	    selected_profile: z.string().min(1),
	    selected_model: z.string().min(1),
	    provider: z.string().min(1),
	    strategy: z.enum([
	      "primary",
	      "fallback",
	      "hedged",
	      "telemetry_fallback",
	      "llm_primary",
	      "llm_fallback",
	    ]),
	    reason: z.string().min(1),
	    latency_ms: z.number().int().min(0).optional(),
	    resolved_on_primary: z.boolean(),
	  }),
	  ]);

export const AuditEntrySchema = CommonLogFieldsSchema.extend({
  kind: z.enum([
    "policy_block",
    "path_escape",
    "rules_change",
    "no_progress_detected",
    "completion_gate_exhausted",
    "verification_gate",
    "skill_committed",
    "lesson_recorded",
    "complete_task_synthesis_blocked",
    "tool_args_strip_failed",
    "tool_args_stripped",
    "failure_memory_load_failed",
    "verified_lessons_load_failed",
  ]),
  severity: z.enum(["warn", "error"]),
  rule_id: z.string().min(1).optional(),
  would_block: z.boolean().optional(),
  message: z.string().min(1),
  sig: z.string().min(1).optional(),
  count: z.number().int().min(0).optional(),
  plan_step_id: z.string().min(1).optional(),
  stop_reason: z.enum(["solved", "no_progress_stop", "gate_exhausted", "harness_timeout", "infra_failed", "error"]).optional(),
  signal: z.string().min(1).optional(),
  skill_id: z.string().min(1).optional(),
  lesson_id: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type TrajectoryEntry = z.infer<typeof TrajectoryEntrySchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export function parseTrajectoryEntry(input: unknown): TrajectoryEntry {
  return TrajectoryEntrySchema.parse(input);
}

export function parseAuditEntry(input: unknown): AuditEntry {
  return AuditEntrySchema.parse(input);
}
