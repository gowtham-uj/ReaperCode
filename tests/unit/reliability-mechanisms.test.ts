import test from "node:test";
import assert from "node:assert/strict";

import { buildArtifactObligationLedger, getArtifactObligationBlocker } from "../../src/runtime/artifact-obligations.js";
import { buildRescueHypothesisLedger } from "../../src/runtime/hypothesis-ledger.js";
import { recoverCompleteToolCallEnvelope } from "../../src/model/json-response.js";
import { deriveCanonicalSecretEncodings } from "../../src/runtime/derived-secret-encoding.js";
import { enforcePatcherStatusIntegrity, isBehavioralVerificationCommand } from "../../src/runtime/status-integrity.js";
import type { ToolResult } from "../../src/tools/types.js";
import { buildContractCoverageMatrix, getContractCoverageBlocker } from "../../src/verify/contract-coverage.js";

test("artifact obligation ledger requires a producer and strict contract verification", () => {
  const results: ToolResult[] = [
    failedShell("verify", "python check.py", "FileNotFoundError: [Errno 2] No such file or directory: 'outputs/report.json'"),
    successfulShell("produce", "python generate.py outputs/report.json", "wrote outputs/report.json"),
    {
      toolCallId: "read",
      name: "read_file",
      ok: true,
      durationMs: 1,
      args: { path: "outputs/report.json" },
      output: { content: "{}" },
    },
  ];

  const ledger = buildArtifactObligationLedger("Create outputs/report.json with the requested schema.", results);
  assert.equal(ledger.total, 1);
  assert.equal(ledger.obligations[0]?.state, "produced");
  assert.match(getArtifactObligationBlocker("Create outputs/report.json with the requested schema.", results) ?? "", /strict content\/schema\/behavior check/i);
});

test("artifact obligation ledger clears after an authoritative test passes", () => {
  const results: ToolResult[] = [
    failedShell("verify", "python check.py", "No such file or directory: 'outputs/report.json'"),
    successfulShell("produce", "python generate.py outputs/report.json", "wrote outputs/report.json"),
    successfulShell("test", "pytest -q", "2 passed"),
  ];

  const ledger = buildArtifactObligationLedger("Create outputs/report.json.", results);
  assert.equal(ledger.obligations[0]?.state, "contract_verified");
  assert.equal(getArtifactObligationBlocker("Create outputs/report.json.", results), undefined);
});

test("artifact obligation ledger does not treat a path being verified as a requested produced artifact", () => {
  const results = [successfulShell("inspect", "cat output.txt", "ready")];

  assert.equal(buildArtifactObligationLedger("Verify output.txt.", results).total, 0);
  assert.equal(getArtifactObligationBlocker("Verify output.txt.", results), undefined);
});

test("rescue hypothesis ledger derives a discriminating check from failure evidence", () => {
  const ledger = buildRescueHypothesisLedger([
    failedShell("check", "pytest -q", "AssertionError: expected 42 but got 41"),
  ]);

  assert.match(ledger.problemStatement, /assert|expected|failed/i);
  assert.ok(ledger.hypotheses.some((item) => /assertion|acceptance|output contract/i.test(item.cause)));
  assert.ok(ledger.hypotheses.every((item) => item.discriminatingCheck.length > 20));
});


test("structured recovery executes only independently complete tool calls", () => {
  const recovered = recoverCompleteToolCallEnvelope(
    '{"assistant_message":"","tool_calls":[{"id":"inspect","name":"read_file","args":{"path":"README.md"}},{"id":"partial","name":"write_file","args":{"path":"out.txt","content":"unfinished',
  );
  assert.deepEqual(recovered?.tool_calls, [{ id: "inspect", name: "read_file", args: { path: "README.md" } }]);
  assert.equal(
    recoverCompleteToolCallEnvelope(
      '{"assistant_message":"","tool_calls":[{"id":"partial","name":"write_file","args":{"path":"out.txt","content":"unfinished',
    ),
    undefined,
  );
});


test("patcher verified status is downgraded without a mutation and behavioral check", () => {
  const result = enforcePatcherStatusIntegrity({
    status: "patched_and_verified",
    filesChanged: [],
    behaviorChanged: ["inspected service"],
    testsRun: [{ command: "ls -la /app", result: "passed" }],
    tool_calls: [],
  });
  assert.equal(result.status, "patch_in_progress");
  assert.equal(isBehavioralVerificationCommand("ls -la /app"), false);
  assert.equal(isBehavioralVerificationCommand("curl -fsS http://api/health"), true);
});

test("derived secret encoding ladder preserves value and applies implied fixed width", () => {
  assert.deepEqual(deriveCanonicalSecretEncodings("819", "Passcode = sum % 100000"), ["00819"]);
  assert.deepEqual(deriveCanonicalSecretEncodings("819", "No fixed-width contract"), []);
});


test("contract coverage matrix blocks uncovered requirements and accepts a broad authoritative test", () => {
  const prompt = [
    "Create outputs/report.json with the requested schema.",
    "Ensure the service responds to the health endpoint.",
  ].join("\n");

  assert.match(getContractCoverageBlocker(prompt, []) ?? "", /no strict executable evidence/i);
  const matrix = buildContractCoverageMatrix(prompt, [successfulShell("test", "pytest -q", "4 passed")]);
  assert.equal(matrix.covered, matrix.total);
  assert.equal(getContractCoverageBlocker(prompt, [successfulShell("test", "pytest -q", "4 passed")]), undefined);
});

function successfulShell(id: string, cmd: string, stdout: string): ToolResult {
  return {
    toolCallId: id,
    name: "bash",
    ok: true,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 0, stdout, stderr: "" },
  };
}

function failedShell(id: string, cmd: string, message: string): ToolResult {
  return {
    toolCallId: id,
    name: "bash",
    ok: false,
    durationMs: 1,
    args: { cmd },
    error: { code: "command_failed", message },
  };
}
