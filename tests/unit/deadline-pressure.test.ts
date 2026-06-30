import * as assert from "node:assert/strict";
import { test } from "node:test";

import { getRuntimeDeadlineMs, getRuntimeDeadlinePressure } from "../../src/runtime/deadline-pressure.js";

test("getRuntimeDeadlineMs prefers millisecond deadline env vars", () => {
  assert.equal(
    getRuntimeDeadlineMs({
      REAPER_RUN_DEADLINE_MS: "120000",
      REAPER_AGENT_TIMEOUT_MS: "300000",
      REAPER_TBENCH_TIMEOUT_SEC: "60",
    }),
    120000,
  );
});

test("getRuntimeDeadlineMs falls back to terminal-bench seconds", () => {
  assert.equal(getRuntimeDeadlineMs({ REAPER_TBENCH_TIMEOUT_SEC: "7" }), 7000);
  assert.equal(getRuntimeDeadlineMs({ REAPER_TBENCH_AGENT_TIMEOUT_SEC: "9" }), 9000);
});

test("getRuntimeDeadlineMs ignores invalid and non-positive values", () => {
  assert.equal(getRuntimeDeadlineMs({ REAPER_RUN_DEADLINE_MS: "nope", REAPER_AGENT_TIMEOUT_MS: "0" }), undefined);
});

test("getRuntimeDeadlinePressure is inactive without a configured deadline", () => {
  const previous = process.env.REAPER_RUN_DEADLINE_MS;
  delete process.env.REAPER_RUN_DEADLINE_MS;
  try {
    const pressure = getRuntimeDeadlinePressure(1_000, 2_500);
    assert.deepEqual(pressure, { active: false, critical: false, elapsedMs: 1500 });
  } finally {
    if (previous === undefined) delete process.env.REAPER_RUN_DEADLINE_MS;
    else process.env.REAPER_RUN_DEADLINE_MS = previous;
  }
});

test("getRuntimeDeadlinePressure activates at 65 percent and becomes critical near deadline", () => {
  const previous = process.env.REAPER_RUN_DEADLINE_MS;
  process.env.REAPER_RUN_DEADLINE_MS = "1000000";
  try {
    const active = getRuntimeDeadlinePressure(0, 650000);
    assert.equal(active.active, true);
    assert.equal(active.critical, false);
    assert.match(active.feedback ?? "", /deadline pressure is active/i);

    const critical = getRuntimeDeadlinePressure(0, 820000);
    assert.equal(critical.active, true);
    assert.equal(critical.critical, true);
    assert.match(critical.feedback ?? "", /critical/i);
    assert.match(critical.negativeConstraint ?? "", /broad refactors/i);
  } finally {
    if (previous === undefined) delete process.env.REAPER_RUN_DEADLINE_MS;
    else process.env.REAPER_RUN_DEADLINE_MS = previous;
  }
});
