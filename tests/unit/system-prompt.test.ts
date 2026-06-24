import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemPromptForRole,
  getSystemPromptPrefix,
} from "../../src/runtime/prompt-builders.js";

test("system prompt prefix is byte-stable across calls", () => {
  const a = getSystemPromptPrefix();
  const b = getSystemPromptPrefix();
  const c = getSystemPromptPrefix();
  assert.equal(a, b);
  assert.equal(b, c);
});

test("system prompt prefix contains the agent contract essentials", () => {
  const text = getSystemPromptPrefix();
  assert.match(text, /# Reaper Sub-Agent Contract/);
  assert.match(text, /## Tool Calls/);
  assert.match(text, /## Output Schema/);
  assert.match(text, /## Agent Reliability Patterns/);
  assert.match(text, /## Editor Discipline/);
  assert.match(text, /## Acceptance Discipline/);
  // Tool examples are included
  assert.match(text, /read_file: \{/);
  assert.match(text, /run_shell_command: \{/);
});

test("role-specific extensions add role-specific rules", () => {
  const base = getSystemPromptPrefix();
  const planner = buildSystemPromptForRole("planner");
  const patcher = buildSystemPromptForRole("patcher");
  const executor = buildSystemPromptForRole("executor");
  const recovery = buildSystemPromptForRole("recovery");

  // planner has planner-specific rules
  assert.ok(planner.length > base.length);
  assert.match(planner, /Planner Discipline/);

  // patcher has patcher-specific rules
  assert.match(patcher, /Patcher Discipline/);

  // executor (default) has no role extension
  assert.equal(executor, base);

  // recovery has recovery-specific rules
  assert.match(recovery, /Recovery Discipline/);
});

test("system prompt never contains run-specific state", () => {
  // The prefix must be deterministic — no timestamps, no runIds, no env data.
  const a = getSystemPromptPrefix();
  const b = getSystemPromptPrefix();
  assert.equal(a, b);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "must not contain timestamps");
});

test("system prompt size stays reasonable", () => {
  const text = getSystemPromptPrefix();
  // Should be < 20KB to fit comfortably in cache prefixes.
  assert.ok(text.length < 20_000);
  // Should be > 1KB so it actually carries rules.
  assert.ok(text.length > 1_000);
});