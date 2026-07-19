import test from "node:test";
import assert from "node:assert/strict";

import { parseAuditEntry, parseTrajectoryEntry } from "../../src/logging/schema.js";

function baseLogFields() {
  return {
    event_id: "event-1",
    run_id: "run-1",
    session_id: "session-1",
    trace_id: "trace-1",
    timestamp: "2026-05-05T12:00:00.000Z",
    log_schema_version: 1 as const,
  };
}

test("parses a trajectory verification summary entry", () => {
  const entry = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "verification_summary",
    level: "info",
    attempt_count: 1,
    pass_fail: "pass",
    lite_verified: false,
  });

  assert.equal(entry.kind, "verification_summary");
});

test("rejects invalid trajectory kinds", () => {
  assert.throws(
    () =>
      parseTrajectoryEntry({
        ...baseLogFields(),
        kind: "unknown_kind",
        level: "info",
      }),
    /Invalid discriminator value/,
  );
});

test("rejects wrong log schema version", () => {
  assert.throws(
    () =>
      parseTrajectoryEntry({
        ...baseLogFields(),
        kind: "session_start",
        level: "info",
        user_intent_summary: "Fix the tests",
        log_schema_version: 2,
      }),
    /Invalid literal value/,
  );
});

test("rejects malformed audit entries", () => {
  assert.throws(
    () =>
      parseAuditEntry({
        ...baseLogFields(),
        kind: "policy_block",
        severity: "warn",
        message: "",
      }),
    /String must contain at least 1 character/,
  );
});

test("parses a valid audit entry", () => {
  const entry = parseAuditEntry({
    ...baseLogFields(),
    kind: "path_escape",
    severity: "error",
    message: "Path escaped workspace root",
  });

  assert.equal(entry.kind, "path_escape");
});

test("parses phase 0 session metrics fields", () => {
  const entry = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "session_metrics",
    level: "info",
    tool_count: 5,
    failure_count: 1,
    verification_attempts: 2,
    total_runtime_ms: 1234,
    total_tool_calls: 5,
    max_action_repeat: 3,
    no_progress_trips: 1,
    completion_gate_attempts: 2,
    verified_completion: false,
    stop_reason: "no_progress_stop",
  });

  assert.equal(entry.kind, "session_metrics");
  assert.equal(entry.max_action_repeat, 3);
});

test("parses legacy session metrics without phase 0 fields", () => {
  const entry = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "session_metrics",
    level: "info",
    tool_count: 5,
    failure_count: 1,
    verification_attempts: 2,
    total_runtime_ms: 1234,
  });

  assert.equal(entry.kind, "session_metrics");
});

test("parses phase 0 audit event kinds", () => {
  for (const kind of ["no_progress_detected", "completion_gate_exhausted", "verification_gate", "skill_committed", "lesson_recorded"] as const) {
    const entry = parseAuditEntry({
      ...baseLogFields(),
      event_id: `event-${kind}`,
      kind,
      severity: "warn",
      message: `${kind} occurred`,
      details: { source: "test" },
    });

    assert.equal(entry.kind, kind);
  }
});

test("full_summary accepts blocking flag and context_shake accepts wiring extras", () => {
  const summary = parseTrajectoryEntry({
    event_id: "11111111-1111-4111-8111-111111111111",
    run_id: "run-1",
    session_id: "session-1",
    trace_id: "trace-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    log_schema_version: 1,
    kind: "full_summary",
    level: "info",
    summary_chars: 12,
    kept_messages: 2,
    ptl_drops: 0,
    saved_chars: 5,
    blocking: true,
  });
  assert.equal(summary.kind, "full_summary");
  assert.equal((summary as { blocking?: boolean }).blocking, true);

  const shake = parseTrajectoryEntry({
    event_id: "22222222-2222-4222-8222-222222222222",
    run_id: "run-1",
    session_id: "session-1",
    trace_id: "trace-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    log_schema_version: 1,
    kind: "context_shake",
    level: "info",
    shaken_results: 1,
    saved_chars: 10,
    saved_tokens: 2,
    consecutive_failures: 0,
    superseded_results: 0,
    supersede_saved_chars: 0,
  });
  assert.equal(shake.kind, "context_shake");
  assert.equal((shake as { saved_tokens?: number }).saved_tokens, 2);
});

test("premature_stop_nudge and tool_call_parse_error are accepted", () => {
  const nudge = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "premature_stop_nudge",
    level: "info",
    assistant_excerpt: "Writing f10-f14 now.",
    nudge_count: 1,
    reason: "non_final_summary",
  });
  assert.equal(nudge.kind, "premature_stop_nudge");

  const parseErr = parseTrajectoryEntry({
    ...baseLogFields(),
    event_id: "event-parse",
    kind: "tool_call_parse_error",
    level: "info",
    dropped: [{ name: "scratchpad", error: "invalid args" }],
  });
  assert.equal(parseErr.kind, "tool_call_parse_error");
});

test("thinking trajectory entry accepts reasoning text + turn_index", () => {
  const thinking = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "thinking",
    level: "info",
    content: "Considering the workspace state before opening my next file",
    turn_index: 3,
  });
  assert.equal(thinking.kind, "thinking");
  if (thinking.kind === "thinking") {
    assert.equal(thinking.turn_index, 3);
  }
});

test("run_end trajectory entry accepts completed status and final message", () => {
  const runEnd = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "run_end",
    level: "info",
    status: "completed",
    final_assistant_message: "All goals met.",
    duration_ms: 4242,
  });
  assert.equal(runEnd.kind, "run_end");
});

test("session_start accepts provider/model/run_params metadata", () => {
  const enriched = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "session_start",
    level: "info",
    user_intent_summary: "Build it",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    run_params: { workspace_root: "/tmp/ws", max_tokens: 4096 },
  });
  assert.equal(enriched.kind, "session_start");
});

test("token_budget accepts optional reasoning-tokens + cost fields", () => {
  const enriched = parseTrajectoryEntry({
    ...baseLogFields(),
    kind: "token_budget",
    level: "info",
    turn_input_tokens: 100,
    turn_output_tokens: 50,
    turn_cache_read_tokens: 0,
    turn_cache_write_tokens: 0,
    turn_call_count: 1,
    cumulative_input_tokens: 100,
    cumulative_output_tokens: 50,
    cumulative_cache_read_tokens: 0,
    cumulative_cache_write_tokens: 0,
    cumulative_call_count: 1,
    turn_reasoning_tokens: 17,
    cumulative_reasoning_tokens: 17,
    cost_usd: 0.0042,
  });
  assert.equal(enriched.kind, "token_budget");
});

