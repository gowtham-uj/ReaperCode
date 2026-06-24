import test from "node:test";
import assert from "node:assert/strict";

import { selectBestRollout, type RolloutCandidate } from "../../src/runtime/best-of-n.js";
import type { ToolResult } from "../../src/tools/types.js";

test("best-of-N selects the rollout that passes tests over one that only self-reports success", () => {
  const selfReport: RolloutCandidate = {
    id: "rollout-1",
    result: {
      assistantMessage: "Done.",
      toolResults: [],
    },
  };
  const verified: RolloutCandidate = {
    id: "rollout-2",
    result: {
      assistantMessage: "Done after tests.",
      verification: { ok: true, command: "npm test" },
      toolResults: [
        {
          toolCallId: "test",
          name: "run_shell_command",
          ok: true,
          durationMs: 10,
          args: { cmd: "npm test" },
          output: { exitCode: 0, stdout: "pass", stderr: "" },
        } satisfies ToolResult,
      ],
    },
  };

  const winner = selectBestRollout([selfReport, verified]);

  assert.equal(winner?.id, "rollout-2");
});

test("best-of-N uses execution agreement as the tie-breaker after verification", () => {
  const candidates = [
    rollout("rollout-1", "unique"),
    rollout("rollout-2", "agreed"),
    rollout("rollout-3", "agreed"),
  ];

  const winner = selectBestRollout(candidates);

  assert.equal(winner?.id, "rollout-2");
  assert.equal(winner?.agreementCount, 2);
});

function rollout(id: string, stdout: string) {
  return {
    id,
    result: {
      assistantMessage: "partial",
      toolResults: [
        {
          toolCallId: `${id}-check`,
          name: "run_shell_command",
          ok: true,
          durationMs: 1,
          args: { cmd: "node check.js" },
          output: { exitCode: 0, stdout, stderr: "" },
        } satisfies ToolResult,
      ],
    },
  };
}
