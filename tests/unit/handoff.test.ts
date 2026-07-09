/**
 * Tests for context/handoff.ts (T3 OMP port).
 *
 * Handoff is the smaller-context alternative to full_summary.
 * Same gate as full-summary (shouldCompact), but uses a 4-section
 * output template instead of the OMP 9-section summary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldHandoff, HANDOFF_SUMMARY_SYSTEM_PROMPT, HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS } from "../../src/context/handoff.js";

test("shouldHandoff returns fire=true when tokens exceed threshold", () => {
  // softCap = 100_000, reserve = max(16,384, 15,000) = 16,384
  // threshold = 100_000 - 16,384 = 83,616
  // tokensUsed = 83,617 > 83,616 → fire
  const result = shouldHandoff(83_617, 100_000);
  assert.equal(result.fire, true);
  assert.equal(result.thresholdTokens, 83_616);
});

test("shouldHandoff uses OMP-aligned threshold formula (softCap - max(16K, softCap*0.15))", () => {
  // softCap = 100,000 → reserve = max(16,384, 15,000) = 16,384
  // threshold = 100,000 - 16,384 = 83,616
  const result = shouldHandoff(83_617, 100_000);
  assert.equal(result.fire, true);
  assert.equal(result.thresholdTokens, 83_616);
  assert.equal(result.tokensUsed, 83_617);
});

test("shouldHandoff handles tiny softCap with proportional fallback", () => {
  // softCap = 200 → reserve = max(16,384, 30) = 16,384
  // threshold = max(0, 200 - 16,384) = 0
  // fire = tokensUsed > 0
  const result = shouldHandoff(1, 200);
  assert.equal(result.fire, true);
});

test("HANDOFF_SUMMARY_SYSTEM_PROMPT is non-empty and mentions 4 sections", () => {
  assert.ok(HANDOFF_SUMMARY_SYSTEM_PROMPT.length > 100, "system prompt should be substantive");
  assert.ok(HANDOFF_SUMMARY_SYSTEM_PROMPT.includes("4-section"));
});

test("HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS lists all 4 sections", () => {
  const sections = ["Active Task", "Current State", "Files Touched", "Next Action"];
  for (const s of sections) {
    assert.ok(HANDOFF_SUMMARY_USER_PROMPT_INSTRUCTIONS.includes(s), `must list section: ${s}`);
  }
});

test("HANDOFF_SUMMARY_SYSTEM_PROMPT forbids meta-commentary and I-am-an-AI preamble", () => {
  assert.ok(HANDOFF_SUMMARY_SYSTEM_PROMPT.includes("meta-commentary"));
  assert.ok(HANDOFF_SUMMARY_SYSTEM_PROMPT.includes("I am an AI"));
});

test("shouldHandoff returns fire=false when tokens below threshold", () => {
  // softCap = 200_000, reserve = max(16,384, 30,000) = 30,000
  // threshold = 200_000 - 30,000 = 170_000
  const result = shouldHandoff(100_000, 200_000);
  assert.equal(result.fire, false);
  assert.equal(result.thresholdTokens, 170_000);
  assert.equal(result.tokensUsed, 100_000);
});