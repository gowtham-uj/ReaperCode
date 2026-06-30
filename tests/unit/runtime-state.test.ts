import test from "node:test";
import assert from "node:assert/strict";

import { parseRuntimeState } from "../../src/runtime/state.js";

function createRuntimeState() {
  return {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    noticeVerbosity: "normal",
    sessionProtocolVersion: 1,
    userIntentSummary: "Fix the failing test",
    tokenBudget: {
      softCap: 200000,
      inputTokens: 0,
      outputTokens: 0,
    },
    epicState: {
      objectives: [],
    },
    feedback: [],
    negativeConstraints: [],
  };
}

test("parses a valid runtime state", () => {
  const state = parseRuntimeState(createRuntimeState());

  assert.equal(state.sessionProtocolVersion, 1);
});

test("rejects negative token counts", () => {
  const state = createRuntimeState();
  state.tokenBudget.inputTokens = -1;

  assert.throws(() => parseRuntimeState(state), /greater than or equal to 0/);
});

test("rejects wrong session protocol versions", () => {
  const state = createRuntimeState();
  state.sessionProtocolVersion = 2 as 1;

  assert.throws(() => parseRuntimeState(state), /Invalid literal value/);
});
