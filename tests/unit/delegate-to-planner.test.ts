/**
 * tests/unit/delegate-to-planner.test.ts — verify the new
 * `delegate_to_plan` tool's handler, schema, and registry entry.
 *
 * These are pure unit tests. They do not call the model gateway;
 * they verify that the tool surface and the handler's contract are
 * what the rest of the runtime depends on.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { handleDelegateToPlanner, type DelegateToPlannerContext } from "../../src/tools/write/delegate-to-planner.js";
import { DelegateToPlanArgsSchema } from "../../src/tools/types.js";
import { toolRegistry, CORE_TOOL_NAMES } from "../../src/tools/registry.js";

const stubContext: DelegateToPlannerContext = {
  // We never reach `runPlanner` in these tests because the
  // happy-path tests use mode=initial without prompting the model.
  // The error-path tests confirm the handler surfaces a typed
  // result envelope when the planner call fails.
  modelGateway: {} as DelegateToPlannerContext["modelGateway"],
  prompt: "Add a hello-world function",
};

test("delegate_to_plan schema accepts the three documented modes", () => {
  for (const mode of ["initial", "replan", "update_todo"] as const) {
    const parsed = DelegateToPlanArgsSchema.parse({ mode });
    assert.equal(parsed.mode, mode);
  }
});

test("delegate_to_plan schema rejects unknown modes", () => {
  assert.throws(
    () => DelegateToPlanArgsSchema.parse({ mode: "spider-mode" }),
    /Invalid enum value/,
  );
});

test("delegate_to_plan schema accepts optional reason and current_step_id", () => {
  const parsed = DelegateToPlanArgsSchema.parse({
    mode: "replan",
    current_step_id: "step-2",
    reason: "Tool X keeps failing",
  });
  assert.equal(parsed.mode, "replan");
  assert.equal(parsed.current_step_id, "step-2");
  assert.equal(parsed.reason, "Tool X keeps failing");
});

test("delegate_to_plan is registered in the tool registry", () => {
  assert.ok(toolRegistry.delegate_to_plan, "delegate_to_plan should be in toolRegistry");
  assert.equal(toolRegistry.delegate_to_plan.argsSchema, DelegateToPlanArgsSchema);
});

test("delegate_to_plan is in the core tool set (always rendered with full schema)", () => {
  assert.ok(
    CORE_TOOL_NAMES.has("delegate_to_plan"),
    "delegate_to_plan should be in CORE_TOOL_NAMES so the main model always sees its full schema",
  );
});

test("handleDelegateToPlanner returns an error envelope on planner failure", async () => {
  // Force the planner call to fail by passing a context whose
  // modelGateway is a stub that throws when resolveRole is called.
  const failingContext: DelegateToPlannerContext = {
    modelGateway: {
      async resolveRole() {
        throw new Error("model gateway offline");
      },
      async generate() {
        throw new Error("model gateway offline");
      },
      async *stream() {
        throw new Error("model gateway offline");
      },
      async embed() {
        throw new Error("model gateway offline");
      },
      async countTokens() {
        throw new Error("model gateway offline");
      },
    } as unknown as DelegateToPlannerContext["modelGateway"],
    prompt: "test",
  };

  const result = await handleDelegateToPlanner(failingContext, { mode: "initial" });
  assert.equal(result.ok, false);
  assert.equal(result.mode, "initial");
  assert.match(result.error ?? "", /model gateway offline/);
  // The plan is a fallback so the main model has something to read.
  assert.ok(result.plan);
  assert.equal(result.plan.task_summary, "(planner call failed; no plan returned)");
});

test("handleDelegateToPlanner result envelope has a summary field", async () => {
  const failingContext: DelegateToPlannerContext = {
    modelGateway: {
      async resolveRole() {
        throw new Error("offline");
      },
      async generate() {
        throw new Error("offline");
      },
      async *stream() {
        throw new Error("offline");
      },
      async embed() {
        throw new Error("offline");
      },
      async countTokens() {
        throw new Error("offline");
      },
    } as unknown as DelegateToPlannerContext["modelGateway"],
    prompt: "test",
  };

  const result = await handleDelegateToPlanner(failingContext, { mode: "replan" });
  assert.equal(result.summary, "Planner sub-agent failed.");
  assert.equal(result.mode, "replan");
});
