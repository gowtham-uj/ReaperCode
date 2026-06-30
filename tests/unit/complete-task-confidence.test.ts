import test from "node:test";
import assert from "node:assert/strict";

import { CompleteTaskArgsSchema, ToolCallSchema } from "../../src/tools/types.js";

test("CompleteTaskArgsSchema accepts high confidence with verification contract", () => {
  const result = CompleteTaskArgsSchema.parse({
    summary: "Fixed isPalindrome and tests pass.",
    confidence: "high",
    verificationContract: { commands: [{ command: "npm test", required: true }] },
  });
  assert.equal(result.confidence, "high");
  assert.equal(result.verificationContract?.commands?.length, 1);
});

test("CompleteTaskArgsSchema accepts low confidence with clarification and known issues", () => {
  const result = CompleteTaskArgsSchema.parse({
    summary: "Need user input before proceeding.",
    confidence: "low",
    clarification: "Which test framework do you prefer?",
    known_issues: ["User clarification pending on test framework choice"],
  });
  assert.equal(result.confidence, "low");
  assert.equal(result.clarification, "Which test framework do you prefer?");
  assert.equal(result.known_issues?.length, 1);
});

test("CompleteTaskArgsSchema rejects invalid confidence values", () => {
  assert.throws(() =>
    CompleteTaskArgsSchema.parse({ summary: "x", confidence: "maybe" }),
  );
});

test("ToolCallSchema accepts a complete_task with optional confidence and known_issues", () => {
  const parsed = ToolCallSchema.parse({
    id: "ct-1",
    name: "complete_task",
    args: {
      summary: "Done.",
      confidence: "low",
      known_issues: ["Model needed clarification on API choice"],
    },
  });
  if (parsed.name !== "complete_task") throw new Error("wrong name");
  assert.equal(parsed.args.confidence, "low");
});