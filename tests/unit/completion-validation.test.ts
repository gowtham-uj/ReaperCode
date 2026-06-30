import test from "node:test";
import assert from "node:assert/strict";

import {
  validateStrictCompletion,
} from "../../src/runtime/completion-validation.js";
import type { TaskContract } from "../../src/runtime/task-contract.js";
import { createVerificationState, recordVerificationCheck } from "../../src/runtime/verification-state.js";
import type { ToolCall, ToolResult } from "../../src/tools/types.js";

function blockerCodes(result: ReturnType<typeof validateStrictCompletion>): string[] {
  return result.blockers.map((blocker) => blocker.code);
}

function completion(id = "complete"): Extract<ToolCall, { name: "complete_task" }> {
  return {
    id,
    name: "complete_task",
    args: { summary: "answer.txt was created and verified" },
  };
}

function contract(): TaskContract {
  return {
    userGoal: "Create answer.txt and verify it.",
    deliverables: ["Create answer.txt"],
    constraints: [],
    acceptanceCriteria: ["answer.txt contains ok"],
    forbiddenActions: [],
    likelyValidation: ["test \"$(cat answer.txt)\" = ok"],
  };
}

function shellResult(command: string, output = ""): ToolResult {
  return {
    toolCallId: "verify-answer",
    name: "bash",
    ok: true,
    durationMs: 1,
    args: { cmd: command },
    output,
  };
}

test("final-looking text without complete_task is not completion", () => {
  const result = validateStrictCompletion({
    taskContract: contract(),
    toolResults: [shellResult("test \"$(cat answer.txt)\" = ok", "ok\n")],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["missing_complete_task"]);
});

test("complete_task without verification ladder evidence returns blockers", () => {
  const result = validateStrictCompletion({
    toolCalls: [completion()],
    taskContract: contract(),
    toolResults: [
      {
        toolCallId: "write-answer",
        name: "write_file",
        ok: true,
        durationMs: 1,
        args: { path: "answer.txt", content: "ok\n" },
        output: "wrote answer.txt",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["verification_ladder_not_eligible"]);
});

test("complete_task with contract evidence and passed verification is accepted", () => {
  const verification = recordVerificationCheck(createVerificationState(["test \"$(cat answer.txt)\" = ok"]), {
    command: "test \"$(cat answer.txt)\" = ok",
    status: "passed",
    evidence: "answer.txt contains ok",
  });
  const result = validateStrictCompletion({
    toolCalls: [completion()],
    taskContract: contract(),
    verificationState: verification,
    toolResults: [shellResult("test \"$(cat answer.txt)\" = ok", "ok\n")],
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.contractCovered, true);
  assert.equal(result.evidence.verificationEligible, true);
});

test("complete_task batched with a mutating tool is allowed", () => {
  const result = validateStrictCompletion({
    toolCalls: [
      { id: "write-answer", name: "write_file", args: { path: "answer.txt", content: "ok\n" } },
      completion(),
    ],
    taskContract: contract(),
    toolResults: [shellResult("test \"$(cat answer.txt)\" = ok", "ok\n")],
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.contractCovered, true);
});

test("repeated completion attempts without new evidence trip stuck-loop blocker", () => {
  const firstAttempt = validateStrictCompletion({
    toolCalls: [completion("first-complete")],
    taskContract: contract(),
    toolResults: [shellResult("test \"$(cat answer.txt)\" = ok", "ok\n")],
  });
  const result = validateStrictCompletion({
    toolCalls: [completion("retry-complete")],
    taskContract: contract(),
    toolResults: [shellResult("test \"$(cat answer.txt)\" = ok", "ok\n")],
    previousAttemptEvidenceFingerprints: [firstAttempt.evidence.fingerprint],
  });

  assert.equal(result.ok, false);
  assert.ok(blockerCodes(result).includes("repeated_completion_without_new_evidence"));
});

test("missing task-contract evidence is structured separately from verification", () => {
  const result = validateStrictCompletion({
    toolCalls: [completion()],
    taskContract: {
      ...contract(),
      deliverables: ["Create report.json"],
    },
    toolResults: [shellResult("test \"$(cat answer.txt)\" = ok", "ok\n")],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(blockerCodes(result), ["missing_contract_evidence"]);
});
