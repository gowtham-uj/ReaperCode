import test from "node:test";
import assert from "node:assert/strict";

import {
  VerificationOrchestrator,
  findVerificationChecks,
} from "../../src/runtime/verification-orchestrator.js";

test("classifyToolResult returns isCheck=false for non-shell tools", () => {
  const orch = new VerificationOrchestrator();
  assert.equal(orch.classifyToolResult({ toolName: "read_file", args: { path: "x" }, ok: true }).isCheck, false);
});

test("classifyToolResult returns isCheck=false for shell tools that don't match a verification pattern", () => {
  const orch = new VerificationOrchestrator();
  assert.equal(
    orch.classifyToolResult({ toolName: "bash", args: { cmd: "ls -la" }, ok: true }).isCheck,
    false,
  );
});

test("classifyToolResult flags passing npm test as a passed check", () => {
  const orch = new VerificationOrchestrator();
  const candidate = orch.classifyToolResult({
    toolName: "bash",
    args: { cmd: "npm test" },
    ok: true,
    output: { exitCode: 0 },
  });
  assert.equal(candidate.isCheck, true);
  assert.equal(candidate.command, "npm test");
  assert.equal(candidate.status, "passed");
  assert.match(candidate.evidence ?? "", /exitCode=0/);
});

test("classifyToolResult flags failing test as a failed check with the error message", () => {
  const orch = new VerificationOrchestrator();
  const candidate = orch.classifyToolResult({
    toolName: "bash",
    args: { cmd: "npm test" },
    ok: false,
    error: { message: "1 failing" },
  });
  assert.equal(candidate.isCheck, true);
  assert.equal(candidate.status, "failed");
  assert.equal(candidate.evidence, "1 failing");
});

test("ingest applies passing and failing checks to the state", () => {
  const orch = new VerificationOrchestrator();
  let state = orch.initialize(["npm test"]);
  ({ state } = orch.ingest(state, {
    toolName: "bash",
    args: { cmd: "npm test" },
    ok: true,
    output: { exitCode: 0 },
  }));
  assert.equal(state.completedChecks.length, 1);
  assert.equal(state.completedChecks[0]?.status, "passed");
});


test("findVerificationChecks extracts all checks from a result list", () => {
  const orch = new VerificationOrchestrator();
  const results = [
    { toolName: "bash", args: { cmd: "npm test" }, ok: true, output: { exitCode: 0 } },
    { toolName: "bash", args: { cmd: "ls" }, ok: true },
    { toolName: "bash", args: { cmd: "pytest" }, ok: false, error: { message: "x" } },
  ];
  const checks = findVerificationChecks(orch, results);
  assert.equal(checks.length, 2);
  assert.equal(checks[0]?.status, "passed");
  assert.equal(checks[1]?.status, "failed");
});
