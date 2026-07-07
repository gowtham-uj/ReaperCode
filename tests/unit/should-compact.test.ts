import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESERVE_TOKENS,
  charsToTokensO200kBase,
  effectiveReserveTokens,
  resolveBudgetReserveTokens,
  resolveThresholdTokens,
  shouldCompact,
} from "../../src/context/should-compact.js";

test("shouldCompact returns false for enabled=false", () => {
  assert.equal(
    shouldCompact(100_000, 200_000, { softCap: 200_000, enabled: false }),
    false,
  );
});

test("shouldCompact returns true when tokensUsed > threshold", () => {
  // 200K window; reserve is at least 16K → threshold ≤ 184K.
  assert.equal(shouldCompact(190_000, 200_000, { softCap: 200_000 }), true);
});

test("shouldCompact returns false for tiny windows where reserve would consume the window", () => {
  // 200-token window with proportional reserve: reserveTokens = max(1, 200*0.15)=30.
  // threshold = 200-30 = 170. 100 tokens used → no compact.
  assert.equal(shouldCompact(100, 200, { softCap: 200 }), false);
});

test("resolveThresholdTokens uses explicit threshold when provided", () => {
  assert.equal(
    resolveThresholdTokens(200_000, {
      softCap: 200_000,
      thresholdTokens: 50_000,
    }),
    50_000,
  );
});

test("resolveThresholdTokens clamps an explicit threshold to [1, softCap-1]", () => {
  // 0 is invalid → fall back to softCap - reserve (200_000 - 16_384).
  assert.equal(resolveThresholdTokens(200_000, { softCap: 200_000, thresholdTokens: 0 }), 183_616);
  // above softCap → clamped to softCap - 1
  assert.equal(
    resolveThresholdTokens(1000, { softCap: 1000, thresholdTokens: 5000 }),
    999,
  );
});

test("resolveThresholdTokens default = softCap - reserve", () => {
  assert.equal(
    resolveThresholdTokens(200_000, { softCap: 200_000 }),
    200_000 - DEFAULT_RESERVE_TOKENS,
  );
});

test("effectiveReserveTokens returns the configured reserve when above the floor", () => {
  // Default reserve is 16K; floor is 1; softCap above floor.
  assert.equal(effectiveReserveTokens(100), DEFAULT_RESERVE_TOKENS);
  assert.equal(effectiveReserveTokens(100), 16384);
});

test("effectiveReserveTokens returns at least 1 even for tiny windows", () => {
  // softCap is 0 → would return 16384 by default. We don't reach floor here.
  // The proportional-fallback is in resolveBudgetReserveTokens, not here.
  assert.equal(effectiveReserveTokens(0), DEFAULT_RESERVE_TOKENS);
});

test("resolveBudgetReserveTokens falls back to proportional for tiny windows", () => {
  // softCap=200; default reserve 16384 ≥ softCap → proportional: max(1, 30) = 30.
  assert.equal(resolveBudgetReserveTokens(200), 30);
  // softCap=100000; default 16384 < softCap → keep default.
  assert.equal(resolveBudgetReserveTokens(100_000), 16_384);
});

test("effectiveReserveTokens uses provided reserve when larger than floor", () => {
  assert.equal(
    effectiveReserveTokens(200_000, { softCap: 200_000, reserveTokens: 32_000 }),
    32_000,
  );
});

test("charsToTokensO200kBase uses 4:1 ratio with ceiling", () => {
  assert.equal(charsToTokensO200kBase(0), 0);
  assert.equal(charsToTokensO200kBase(4), 1);
  assert.equal(charsToTokensO200kBase(5), 2);
  assert.equal(charsToTokensO200kBase(80_000), 20_000);
});
