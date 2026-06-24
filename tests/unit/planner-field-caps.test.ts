import test from "node:test";
import assert from "node:assert/strict";

import { capPlannerField, parsePlannerSubagentPlan } from "../../src/runtime/prompt-builders.js";
import type { EnvironmentFingerprint } from "../../src/runtime/fingerprint.js";
import type { ToolResult } from "../../src/tools/types.js";

const fp: EnvironmentFingerprint = {
  os: "linux",
  arch: "x64",
  nodeVersion: "v20",
  npmVersion: "10",
  glibcVersion: "2.39",
  cwd: "/tmp/test",
  dockerStatus: "available",
  availableTools: ["git"],
  dockerCliAvailable: true,
  dockerDaemonAvailable: true,
};

test("capPlannerField truncates long strings and marks the truncation", () => {
  const long = "x".repeat(2000);
  const capped = capPlannerField(long, 600);
  assert.ok(capped.length < 700, `expected <700 chars, got ${capped.length}`);
  assert.match(capped, /\.\.\.\[truncated for planner budget\]$/);
});

test("capPlannerField passes through short strings unchanged", () => {
  const short = "short plan";
  assert.equal(capPlannerField(short, 600), "short plan");
});

test("parsePlannerSubagentPlan caps verbose suggestedImplementation and testGuidance fields", () => {
  const huge = "y".repeat(2000);
  const plan = parsePlannerSubagentPlan({
    installs: [],
    steps: [
      {
        id: "x",
        title: "x",
        type: "command",
        instructions: "x",
        suggestedImplementation: huge,
        testGuidance: huge,
        successCriteria: ["criterion " + "z".repeat(1000)],
        tool_calls: [],
      },
    ],
    testGuidance: "ok",
  });
  const step = plan.steps[0]!;
  assert.ok((step.suggestedImplementation ?? "").length < 700);
  assert.match(step.suggestedImplementation ?? "", /\.\.\.\[truncated for planner budget\]$/);
  assert.ok((step.testGuidance ?? "").length < 500);
  assert.ok((step.successCriteria?.[0] ?? "").length < 400);
});

test("parsePlannerSubagentPlan caps step count to 6", () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({
    id: `step-${i}`,
    title: `Step ${i}`,
    type: "command" as const,
    instructions: "x",
    tool_calls: [],
  }));
  const plan = parsePlannerSubagentPlan({ installs: [], steps, testGuidance: "ok" });
  assert.equal(plan.steps.length, 6);
});
