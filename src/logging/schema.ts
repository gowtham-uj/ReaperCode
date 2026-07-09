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
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("context_shake"),
	    level: z.enum(["info", "debug", "trace"]),
	    shaken_results: z.number().int().min(0),
	    saved_chars: z.number().int().min(0),
	    saved_tokens: z.number().int().min(0).optional(),
	    consecutive_failures: z.number().int().min(0).optional(),
	    superseded_results: z.number().int().min(0).optional(),
	    supersede_saved_chars: z.number().int().min(0).optional(),
	  }),
	  // Bash head+tail: emitted by the context-engineering wiring's
	  // onAfterToolResult hook when a bash tool result had been truncated
	  // by the executor's persist+head-tail path. Reports the original
	  // size, preview size, and bytes saved.
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("bash_head_tail"),
	    level: z.enum(["info", "debug", "trace"]),
	    tool_name: z.string().min(1).optional(),
	    original_chars: z.number().int().min(0).optional(),
	    preview_chars: z.number().int().min(0).optional(),
	    saved_chars: z.number().int().min(0).optional(),
	  }),
	  // Time-based microcompact: emitted by onAfterModelCall when the time
	  // gap between the last tool result and the current model call exceeds
	  // the configured threshold and we evict stale tool contents.
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("time_microcompact"),
	    level: z.enum(["info", "debug", "trace"]),
	    cleared_messages: z.number().int().min(0).optional(),
	    saved_chars: z.number().int().min(0).optional(),
	    messages_before: z.number().int().min(0).optional(),
	    messages_after: z.number().int().min(0).optional(),
	  }),
	  // PTL recovery: emitted when a 400/413 from the provider triggers
	  // the onProviderTokenLimitError hook to shrink the conversation.
	  CommonLogFieldsSchema.extend({
	    kind: z.literal("ptl_recovery"),
	    level: z.enum(["info", "debug", "trace"]),
	    saved_chars: z.number().int().min(0).optional(),
	    remaining_messages: z.number().int().min(0).optional(),
	  }),
	  // Full summarization: emitted when onBeforeModelCall invoked
	    // tryFullSummarization and replaced the conversation with a
	    // long-form summary.
	    CommonLogFieldsSchema.extend({
	      kind: z.literal("full_summary"),
	      level: z.enum(["info", "debug", "trace"]),
	      summary_chars: z.number().int().min(0).optional(),
	      kept_messages: z.number().int().min(0).optional(),
	      ptl_drops: z.number().int().min(0).optional(),
	      saved_chars: z.number().int().min(0).optional(),
	      /** True when full-summary blocked the model call (OMP runAutoCompaction). */
	      blocking: z.boolean().optional(),
	      }),
	      // T3 Handoff summary: smaller-context alternative to
	      // full_summary. Same schema shape, different `kind` so the
	      // trajectory clearly distinguishes the two paths. OMP
	      // equivalent: `compaction.ts:generateHandoff` was used
	      // instead of `generateSummary`.
	      CommonLogFieldsSchema.extend({
	        kind: z.literal("handoff_summary"),
	        level: z.enum(["info", "debug", "trace"]),
	        summary_chars: z.number().int().min(0).optional(),
	        kept_messages: z.number().int().min(0).optional(),
	        ptl_drops: z.number().int().min(0).optional(),
	        saved_chars: z.number().int().min(0).optional(),
	        handoff_kind: z.string().optional(),
	        blocking: z.boolean().optional(),
	      }),
	      // T1 Idle compaction: emitted when setTimeout fires after
	      // `idleTimeoutSeconds` of model-idle time and tokens exceed
	      // `idleThresholdTokens`. OMP equivalent:
	      // `event-controller.ts:#scheduleIdleCompaction`.
	      CommonLogFieldsSchema.extend({
	        kind: z.literal("idle_compaction"),
	        level: z.enum(["info", "debug", "trace"]),
	        idle_threshold_tokens: z.number().int().min(0),
	        idle_timeout_seconds: z.number().int().min(60).max(3600),
	        tokens_used: z.number().int().min(0),
	        soft_cap: z.number().int().min(0),
	      }),
	      // T2 Incomplete (length-stop) recovery: emitted when the model
	      // returns `stopReason === "length"` AND tokens exceed the OMP
	      // threshold. The wiring stashes a flag on the runId slot;
	      // the next `onBeforeModelCall` triggers a full summary
	      // before the retry. OMP equivalent:
	      // `#checkCompaction("incomplete", assistantMessage)`.
	      CommonLogFieldsSchema.extend({
	        kind: z.literal("incomplete_recovery"),
	        level: z.enum(["info", "debug", "trace"]),
	        stop_reason: z.string().min(1),
	        tokens_used: z.number().int().min(0),
	        soft_cap: z.number().int().min(0),
	      }),
	      // T4 Snapcompact: emitted when `cm.snapcompactEnabled === true`
	      // AND the live conversation has ≥3 consecutive image blocks.
	      // OMP equivalent: `compaction/snapcompact.ts:maybeSnapcompact`.
	      CommonLogFieldsSchema.extend({
	        kind: z.literal("snapcompact"),
	        level: z.enum(["info", "debug", "trace"]),
	        collapsed_images: z.number().int().min(0),
	        messages_before: z.number().int().min(0),
	        messages_after: z.number().int().min(0),
	        saved_chars: z.number().int().min(0),
	      }),
	    // #21 Promote Context Model: emitted by the wiring when tokens/softCap
	    // crosses modelPromotionThresholdRatio AND a sibling profile with a
	    // strictly larger context window exists. The engine reads this to
	    // decide whether to apply a model swap before full-summary fires.
	    // OMP #21 Promote-Context-Model: the wiring writes this when
	    // the conversation is getting large AND there is a sibling
	    // profile with a strictly larger `capabilities.maxContextTokens`.
	    // The engine reads the most recent event for this run and swaps
	    // the active mainAgent role to the promoted sibling.
	    // `from_role` and `to_role` are the canonical role names (e.g.
	    // "default_model" → "secondary_model"); `from_profile` and
	    // `to_profile` are the model ids for diagnostic display.
	    CommonLogFieldsSchema.extend({
	      kind: z.literal("promoted_context_model"),
	      level: z.enum(["info", "debug", "trace"]),
	      from_role: z.string().min(1),
	      from_profile: z.string().min(1),
	      from_context_tokens: z.number().int().min(0),
	      to_role: z.string().min(1),
	      to_profile: z.string().min(1),
	      to_context_tokens: z.number().int().min(0),
	      ratio_trigger: z.number().min(0).max(10),
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
