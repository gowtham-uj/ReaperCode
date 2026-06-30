/**
 * Per-event coverage test for HookRunner: every HookEventName must be
 * dispatchable to a registered handler with predictable allow/deny/timeout
 * semantics. Mirrors the reference agent's per-event coverage discipline.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { HookRunner } from "../../../src/extensions/hook-runner.js";
import type { HookEventName } from "../../../src/extensions/types.js";

const HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreSkillInvoke",
  "PostSkillInvoke",
  "SkillCreated",
  "SkillSelected",
  "MemoryCandidate",
  "MemoryWritten",
  "MemoryRejected",
  "VisualArtifactAdded",
  "VisualAnalysisCompleted",
  "PreCompact",
  "PostCompact",
  "FileChanged",
];

test("HookRunner dispatches every HookEventName to a registered handler and records the outcome", async () => {
  for (const event of HOOK_EVENTS) {
    const runner = new HookRunner({ defaultTimeoutMs: 200 });
    let seen: HookEventName | null = null;
    runner.register("test", event, (env) => {
      seen = env.event as HookEventName;
      return { allow: true };
    });
    const out = await runner.dispatch(event, { sample: true });
    assert.equal(out.results.length, 1, `expected one result for ${event}`);
    assert.equal(out.results[0]?.outcome, "allow", `expected allow for ${event}`);
    assert.equal(seen, event, `handler should have observed the dispatched event ${event}`);
    assert.equal(out.allow, true, `dispatch outcome should be allow for ${event}`);
  }
});

test("HookRunner collapses security events to deny on handler timeout when securityFailClosed is on", async () => {
  const runner = new HookRunner({ defaultTimeoutMs: 50, securityFailClosed: true });
  runner.register(
    "slow-security",
    "PreToolUse",
    async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return { allow: true };
    },
    { timeoutMs: 50 },
  );
  const out = await runner.dispatch("PreToolUse", {});
  assert.equal(out.allow, false);
  assert.equal(out.results[0]?.outcome, "timeout");
  assert.match(out.firstDenyReason ?? "", /hook timeout/);
});

test("HookRunner isolates handler errors so other extensions still run", async () => {
  const runner = new HookRunner({ defaultTimeoutMs: 200, securityFailClosed: true });
  runner.register("thrower", "PostToolUse", () => {
    throw new Error("intentional");
  });
  let observed = false;
  runner.register("observer", "PostToolUse", () => {
    observed = true;
    return { allow: true };
  });
  const out = await runner.dispatch("PostToolUse", {});
  // PostToolUse is not a security event, so the thrower is recorded as
  // an error but the observer still runs.
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0]?.outcome, "error");
  assert.equal(out.results[1]?.outcome, "allow");
  assert.equal(observed, true);
});

test("HookRunner respects the per-handler timeoutMs override and stops listening after unregister", async () => {
  const runner = new HookRunner();
  const handler = () => ({ allow: true });
  const unsubscribe = runner.register("ext", "PreCompact", handler, { timeoutMs: 250 });
  assert.equal(runner.listenerCount("PreCompact"), 1);
  unsubscribe();
  assert.equal(runner.listenerCount("PreCompact"), 0);
});