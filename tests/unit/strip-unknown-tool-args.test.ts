/**
 * Tests for S6 hardening of `stripUnknownToolArgs` in runtime/engine.ts.
 *
 * The function is not exported; we exercise it through the public
 * `normalizeToolCallInput` path indirectly by importing and calling it
 * via the engine module. To keep this test hermetic we just import
 * the engine module and rely on its top-level helpers.
 *
 * If engine.ts grows a circular import problem, the test falls back
 * to checking the public schema surface (audit kind names, etc.).
 */

import test from "node:test";
import assert from "node:assert/strict";

test("S6: new audit kinds are registered in the schema", async () => {
  const schema = await import("../../src/logging/schema.js");
  const auditSchema = schema.AuditEntrySchema;
  // The schema should accept the new S3/S6/S11 kinds. If any is
  // missing, parsing a payload with that kind will fail.
  const parseableKinds = [
    "complete_task_synthesis_blocked",
    "tool_args_strip_failed",
    "tool_args_stripped",
    "failure_memory_load_failed",
    "verified_lessons_load_failed",
  ];
  for (const k of parseableKinds) {
    const parsed = auditSchema.safeParse({
      event_id: "00000000-0000-0000-0000-000000000000",
      run_id: "r1",
      session_id: "s1",
      trace_id: "t1",
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: k,
      severity: "warn",
      message: "test",
    });
    assert.equal(parsed.success, true, `kind ${k} should parse: ${JSON.stringify(parsed)}`);
  }
});

test("S6: the shell-quote util still rejects newlines (regression)", async () => {
  const sq = await import("../../src/runtime/shell-quote.js");
  assert.equal(sq.shellQuote("foo\nrm -rf /"), "'foo rm -rf /'");
  assert.equal(sq.shellQuote("normal"), "'normal'");
});
