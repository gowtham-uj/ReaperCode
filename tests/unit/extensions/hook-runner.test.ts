/**
 * AC13: Hook timeout enforced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HookRunner } from "../../../src/extensions/hook-runner.js";

test("AC13: slow handler times out and is reported, not thrown", async () => {
  const runner = new HookRunner({ defaultTimeoutMs: 50 });
  runner.register(
    "slow",
    "PreToolUse",
    async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { allow: true };
    },
    { timeoutMs: 50 },
  );
  const out = await runner.dispatch("PreToolUse", {});
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]?.outcome, "timeout");
});

test("AC13b: fast handler resolves normally", async () => {
  const runner = new HookRunner({ defaultTimeoutMs: 1000 });
  runner.register("fast", "PreToolUse", async () => ({ allow: true }));
  const out = await runner.dispatch("PreToolUse", {});
  assert.equal(out.results[0]?.outcome, "allow");
});

test("AC13c: throwing handler is isolated, not propagated", async () => {
  const runner = new HookRunner({ defaultTimeoutMs: 1000 });
  runner.register("thrower", "PreToolUse", async () => {
    throw new Error("intentional");
  });
  const out = await runner.dispatch("PreToolUse", {});
  assert.equal(out.results[0]?.outcome, "error");
});
