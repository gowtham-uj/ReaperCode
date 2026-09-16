/**
 * Context pressure, and the two accounting mistakes it exists to avoid.
 *
 * The cases that matter are the ones where the naive formula
 * (`input + output + reasoning + cache` over the raw window) disagrees with the
 * answer, because those are the reports other agents get: a meter reading over
 * 100%, and a meter that confidently shows a percentage against a limit nobody
 * can trace.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { computeContextUsage } from "../../../src/model/context-usage.js";

test("the percentage is prompt tokens over the limit", () => {
  const usage = computeContextUsage({ promptTokens: 84_000, window: 200_000 });
  assert.equal(usage.contextLimit, 200_000);
  assert.equal(usage.percent, 42);
  assert.equal(usage.remaining, 116_000);
  assert.equal(usage.limitSource, "catalog");
  assert.equal(usage.estimated, false);
});

test("a reserved output budget is subtracted from the limit", () => {
  /*
   * A request that declares `max_tokens: 32_000` against a 200k window can
   * only hold about 168k of prompt, so 84k of prompt is 50% full rather than
   * 42%. Dividing by the raw window understates pressure, which is the
   * failure that matters: it delays compaction until the request is rejected.
   */
  const usage = computeContextUsage({ promptTokens: 84_000, window: 200_000, reservedOutputTokens: 32_000 });
  assert.equal(usage.contextLimit, 168_000);
  assert.equal(usage.percent, 50);
  assert.equal(usage.remaining, 84_000);
  assert.equal(usage.reservedOutputTokens, 32_000);
});

test("percent is clamped at 100 rather than reporting over-full", () => {
  /*
   * Above 100 is never information. It means the accounting disagrees with
   * reality, and showing it asks the user to interpret an arithmetic problem
   * they cannot see. This is the shape of the reported "over 100%" bug.
   */
  const usage = computeContextUsage({ promptTokens: 250_000, window: 200_000 });
  assert.equal(usage.percent, 100);
  assert.equal(usage.remaining, 0, "remaining floors at zero rather than going negative");
});

test("an unknown window produces no percentage, and says so", () => {
  /*
   * The safest failure. Inventing a denominator gives a confidently wrong
   * percentage that cannot be traced to a source; `null` plus
   * `limitSource: "unknown"` lets the renderer say "unknown", which is true
   * and actionable.
   */
  const usage = computeContextUsage({ promptTokens: 5_000, window: null });
  assert.equal(usage.percent, null);
  assert.equal(usage.contextLimit, null);
  assert.equal(usage.remaining, null);
  assert.equal(usage.limitSource, "unknown");
  assert.equal(usage.promptTokens, 5_000, "the count is still reported");
});

test("a zero or negative window is treated as unknown, not as a full meter", () => {
  // `Math.max(1, ...)` on the denominator would have made every request look
  // over-limit against a 0 window. Returning null is the honest answer.
  for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const usage = computeContextUsage({ promptTokens: 100, window });
    assert.equal(usage.percent, null, `window ${window} must not produce a percentage`);
    assert.equal(usage.limitSource, "unknown");
  }
});

test("the limit source is carried through so the number is attributable", () => {
  // Explicit config is more authoritative than catalog metadata, and the
  // difference is worth reporting: a wrong window is only debuggable if the
  // reader can see where it came from.
  for (const source of ["config", "catalog", "registry"] as const) {
    const usage = computeContextUsage({ promptTokens: 1_000, window: 100_000, source });
    assert.equal(usage.limitSource, source);
  }
});

test("low usage keeps one decimal so a live meter visibly moves", () => {
  /*
   * The report that produced this. A turn grew the prompt from 5,064 to 5,899
   * tokens against a 238k limit: 2.13% to 2.48%. Rounded to whole percent both
   * read "2%", so an accurate meter looked frozen for the whole turn. One
   * decimal below 10% makes the movement visible; above it the integer is the
   * useful reading.
   */
  const early = computeContextUsage({ promptTokens: 5_064, window: 243_000, reservedOutputTokens: 32_000 });
  const later = computeContextUsage({ promptTokens: 5_899, window: 243_000, reservedOutputTokens: 32_000 });
  assert.equal(early.percent, 2.4);
  assert.equal(later.percent, 2.8);
  assert.notEqual(early.percent, later.percent, "a small real change must change the reading");

  // Above 10%, whole numbers.
  const large = computeContextUsage({ promptTokens: 84_000, window: 200_000 });
  assert.equal(large.percent, 42);
  assert.equal(Number.isInteger(large.percent), true);
});

test("an estimate is marked as one", () => {
  // Before the provider answers, the size can only be estimated. A renderer
  // that cannot tell the two apart makes an estimate look authoritative.
  const usage = computeContextUsage({ promptTokens: 1_000, window: 100_000, estimated: true });
  assert.equal(usage.estimated, true);
});

test("the model name is carried when known and absent when not", () => {
  const named = computeContextUsage({ promptTokens: 1, window: 100, model: "deepseek-v4-flash" });
  assert.equal(named.model, "deepseek-v4-flash");
  // Omitted rather than set to a placeholder: a guessed name would make the
  // percentage look attributable to a model that did not produce it.
  const anonymous = computeContextUsage({ promptTokens: 1, window: 100 });
  assert.equal("model" in anonymous, false);
});

test("negative inputs are floored rather than propagating", () => {
  const usage = computeContextUsage({ promptTokens: -5, window: 100_000, reservedOutputTokens: -10 });
  assert.equal(usage.promptTokens, 0);
  assert.equal(usage.reservedOutputTokens, 0);
  assert.equal(usage.percent, 0);
});

test("a reservation larger than the window does not produce a divide-by-zero", () => {
  // Absurd input, but it must not produce NaN or Infinity in a meter. The
  // limit floors at 1, which makes the request read as over-full, and that is
  // the right answer for a reservation that cannot fit.
  const usage = computeContextUsage({ promptTokens: 10, window: 1_000, reservedOutputTokens: 5_000 });
  assert.equal(usage.contextLimit, 1);
  assert.equal(usage.percent, 100);
  assert.ok(Number.isFinite(usage.percent));
});
