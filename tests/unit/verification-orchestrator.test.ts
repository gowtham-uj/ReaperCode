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
    orch.classifyToolResult({ toolName: "run_shell_command", args: { cmd: "ls -la" }, ok: true }).isCheck,
    false,
  );
});

test("classifyToolResult flags passing npm test as a passed check", () => {
  const orch = new VerificationOrchestrator();
  const candidate = orch.classifyToolResult({
    toolName: "run_shell_command",
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
    toolName: "run_shell_command",
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
    toolName: "run_shell_command",
    args: { cmd: "npm test" },
    ok: true,
    output: { exitCode: 0 },
  }));
  assert.equal(state.completedChecks.length, 1);
  assert.equal(state.completedChecks[0]?.status, "passed");
});

test("evaluateCompletion allows complete_task when no required checks are defined", () => {
  const orch = new VerificationOrchestrator();
  const state = orch.initialize();
  const verdict = orch.evaluateCompletion(state);
  assert.equal(verdict.allowed, true);
});

test("evaluateCompletion blocks complete_task when required checks have not run", () => {
  const orch = new VerificationOrchestrator();
  const state = orch.initialize(["npm test"]);
  const verdict = orch.evaluateCompletion(state);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.missingRequiredChecks.length, 1);
});

test("evaluateCompletion allows complete_task after a passing required check", () => {
  const orch = new VerificationOrchestrator();
  let state = orch.initialize(["npm test"]);
  ({ state } = orch.ingest(state, {
    toolName: "run_shell_command",
    args: { cmd: "npm test" },
    ok: true,
    output: { exitCode: 0 },
  }));
  const verdict = orch.evaluateCompletion(state);
  assert.equal(verdict.allowed, true);
});

test("evaluateCompletion with requireAllChecks blocks when only one of two required checks has passed", () => {
  const orch = new VerificationOrchestrator({ requireAllChecks: true });
  let state = orch.initialize(["npm test", "pytest"]);
  ({ state } = orch.ingest(state, {
    toolName: "run_shell_command",
    args: { cmd: "npm test" },
    ok: true,
    output: { exitCode: 0 },
  }));
  const verdict = orch.evaluateCompletion(state);
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.missingRequiredChecks, ["pytest"]);
});

test("evaluateCompletion matches prefix variants (npm test --watch=false)", () => {
  const orch = new VerificationOrchestrator();
  let state = orch.initialize(["npm test"]);
  ({ state } = orch.ingest(state, {
    toolName: "run_shell_command",
    args: { cmd: "npm test --watch=false" },
    ok: true,
    output: { exitCode: 0 },
  }));
  const verdict = orch.evaluateCompletion(state);
  assert.equal(verdict.allowed, true);
});

test("findVerificationChecks extracts all checks from a result list", () => {
  const orch = new VerificationOrchestrator();
  const results = [
    { toolName: "run_shell_command", args: { cmd: "npm test" }, ok: true, output: { exitCode: 0 } },
    { toolName: "run_shell_command", args: { cmd: "ls" }, ok: true },
    { toolName: "run_shell_command", args: { cmd: "pytest" }, ok: false, error: { message: "x" } },
  ];
  const checks = findVerificationChecks(orch, results);
  assert.equal(checks.length, 2);
  assert.equal(checks[0]?.status, "passed");
  assert.equal(checks[1]?.status, "failed");
});
