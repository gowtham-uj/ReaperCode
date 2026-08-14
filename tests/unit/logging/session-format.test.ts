import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionClock,
  mapTrajectoryToMutations,
  parseSessionLine,
  ReaperCustomTypeSchema,
} from "../../../src/logging/session-format.js";
import type { TrajectoryEntry } from "../../../src/logging/schema.js";

function base(kind: TrajectoryEntry["kind"], extra: Record<string, unknown>): TrajectoryEntry {
  return {
    event_id: "e1",
    run_id: "run-1",
    session_id: "session-1",
    trace_id: "trace-1",
    timestamp: new Date().toISOString(),
    log_schema_version: 1,
    level: "info",
    kind,
    ...extra,
  } as TrajectoryEntry;
}

test("context ladder kinds stay first-class customTypes", () => {
  const clock = createSessionClock();
  const ctx = { lane: "main", leafId: null, runId: "run-1" };
  for (const kind of ["context_shake", "bash_head_tail", "time_microcompact", "ptl_recovery"] as const) {
    const extra =
      kind === "context_shake"
        ? { shaken_results: 1, saved_chars: 10 }
        : kind === "bash_head_tail"
          ? { original_chars: 100, preview_chars: 20, saved_chars: 80 }
          : kind === "time_microcompact"
            ? { cleared_messages: 2, saved_chars: 5 }
            : { saved_chars: 9, remaining_messages: 3 };
    const mapped = mapTrajectoryToMutations(base(kind, extra), clock, ctx);
    assert.equal(mapped.length, 1);
    const line = mapped[0]!;
    assert.equal(line.kind, "entry");
    if (line.kind === "entry") {
      assert.equal(line.type, "custom");
      assert.equal(line.customType, kind);
      parseSessionLine(line);
    }
  }
});

test("thinking writes a session message and a first-class custom kind", () => {
  const mapped = mapTrajectoryToMutations(
    base("thinking", { content: "plan the edit", turn_index: 2 }),
    createSessionClock(),
    { lane: "main", leafId: null, runId: "run-1" },
  );
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0]?.kind, "entry");
  if (mapped[0]?.kind === "entry") {
    assert.equal(mapped[0].type, "message");
  }
  assert.equal(mapped[1]?.kind, "entry");
  if (mapped[1]?.kind === "entry") {
    assert.equal(mapped[1].type, "custom");
    assert.equal(mapped[1].customType, "thinking");
  }
  for (const line of mapped) parseSessionLine(line);
});


test("full_summary writes a compaction entry plus first-class custom entry", () => {
  const mapped = mapTrajectoryToMutations(
    base("full_summary", { summary_chars: 12, saved_chars: 40, kept_messages: 3, blocking: true }),
    createSessionClock(),
    { lane: "main", leafId: null, runId: "run-1" },
  );
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0]?.kind, "entry");
  if (mapped[0]?.kind === "entry") assert.equal(mapped[0].type, "compaction");
  assert.equal(mapped[1]?.kind, "entry");
  if (mapped[1]?.kind === "entry") {
    assert.equal(mapped[1].type, "custom");
    assert.equal(mapped[1].customType, "full_summary");
  }
  for (const line of mapped) parseSessionLine(line);
});

test("verification and policy stay first-class", () => {
  const clock = createSessionClock();
  const ctx = { lane: "main", leafId: null, runId: "run-1" };
  const verification = mapTrajectoryToMutations(
    base("verification_summary", { attempt_count: 1, pass_fail: "pass", lite_verified: true }),
    clock,
    ctx,
  );
  const policy = mapTrajectoryToMutations(
    base("policy_decision", { decision_id: "d1", policy_id: "p1", outcome: "allow" }),
    clock,
    ctx,
  );
  assert.equal(verification[0] && "customType" in verification[0] ? verification[0].customType : "", "verification_summary");
  assert.equal(policy[0] && "customType" in policy[0] ? policy[0].customType : "", "policy_decision");
  parseSessionLine(verification[0]);
  parseSessionLine(policy[0]);
});

test("unknown customType is rejected at write time", () => {
  assert.equal(ReaperCustomTypeSchema.safeParse("not_a_real_kind").success, false);
  assert.throws(() =>
    parseSessionLine({
      kind: "entry",
      type: "custom",
      customType: "not_a_real_kind",
      id: "x",
      seq: 1,
      parentId: null,
      timestamp: 1,
    }),
  );
});
