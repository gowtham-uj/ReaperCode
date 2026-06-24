import test from "node:test";
import assert from "node:assert/strict";

import { truncatePatchRequestForPrompt, capToolResultForPatcherPrompt } from "../../src/runtime/prompt-builders.js";

test("truncatePatchRequestForPrompt caps large strings inside failureContext and ledger", () => {
  const huge = "x".repeat(8000);
  const result = truncatePatchRequestForPrompt({
    taskId: "x",
    reasonPatchNeeded: huge,
    failureContext: {
      errorLogs: huge,
      observedBehavior: huge,
      expectedBehavior: huge,
    },
    hypothesisLedger: {
      problemStatement: huge,
      hypotheses: [
        { id: "H1", cause: huge, evidence: [huge, huge, huge, huge, huge, huge, huge, huge] },
      ],
    },
    scope: { filesHint: ["a", "b", "c"] },
    constraints: { preserveApi: true, avoidLargeRefactor: true, maxFilesChanged: 8, styleGuide: huge },
  }) as Record<string, unknown>;
  const ser = JSON.stringify(result);
  assert.ok(ser.length < 40000, `truncated PatchRequest should be <40k chars, got ${ser.length}`);
  // scalar caps
  assert.ok((result.reasonPatchNeeded as string).endsWith("[truncated for patcher prompt budget]"));
  // array caps
  const ledger = result.hypothesisLedger as { hypotheses: Array<{ evidence: string[] }> };
  assert.ok(ledger.hypotheses[0]!.evidence.length <= 4, "evidence array capped");
});

test("capToolResultForPatcherPrompt bounds stdout/output without dropping toolCallId", () => {
  const huge = "y".repeat(8000);
  const capped = capToolResultForPatcherPrompt({
    toolCallId: "abc",
    name: "run_shell_command",
    ok: false,
    args: { cmd: huge },
    stdout: huge,
    stderr: huge,
    error: { message: huge, code: "tool_error" },
  });
  assert.equal(capped.toolCallId, "abc");
  assert.equal(capped.name, "run_shell_command");
  assert.equal(capped.ok, false);
  assert.ok((capped.stdout as string)!.endsWith("[truncated for patcher prompt budget]"));
  assert.ok((capped.error as { message: string }).message!.endsWith("[truncated for patcher prompt budget]"));
  assert.ok(JSON.stringify(capped).length < 12000, `capped result should be <12k chars, got ${JSON.stringify(capped).length}`);
});
