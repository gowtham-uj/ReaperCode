import test from "node:test";
import assert from "node:assert/strict";

import { buildArtifactObligationLedger, getArtifactObligationBlocker } from "../../src/runtime/artifact-obligations.js";
import { buildAutomaticServiceRecoveryCall } from "../../src/runtime/engine.js";
import { buildRescueHypothesisLedger } from "../../src/runtime/hypothesis-ledger.js";
import { detectAlternatingNoProgressPattern } from "../../src/runtime/progress-guard.js";
import { recoverCompleteToolCallEnvelope } from "../../src/model/json-response.js";
import {
  detectServicePathTypeMismatches,
  isConclusiveServiceMountOrEntrypointFailure,
  selectExactBindMountFileRepairSource,
  selectSandboxServiceName,
} from "../../src/tools/executor.js";
import { deriveCanonicalSecretEncodings } from "../../src/runtime/derived-secret-encoding.js";
import { enforcePatcherStatusIntegrity, isBehavioralVerificationCommand } from "../../src/runtime/status-integrity.js";
import { classifyServiceLifecycle } from "../../src/tools/service-lifecycle.js";
import { normalizeToolCall } from "../../src/tools/normalize.js";
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

test("expanded stuck detector catches alternating action-observation loops", () => {
  const results = Array.from({ length: 6 }, (_, index) =>
    failedShell(
      `call-${index}`,
      index % 2 === 0 ? "curl -f http://service/ready" : "sandboxctl logs service",
      index % 2 === 0 ? "connection refused" : "service still starting",
    ),
  );

  const decision = detectAlternatingNoProgressPattern(results, 6);
  assert.equal(decision.tripped, true);
  assert.match(decision.reason ?? "", /alternating no-progress/i);
});

test("service lifecycle distinguishes running from ready and crashed", () => {
  assert.equal(classifyServiceLifecycle({ status: "running", health: "starting", exists: true }), "starting");
  assert.equal(classifyServiceLifecycle({ status: "running", health: "healthy", exists: true }), "ready");
  assert.equal(classifyServiceLifecycle({ status: "exited", health: "none", exists: true }), "crashed");
});

test("sandbox service readiness action normalizes probe aliases", () => {
  const normalized = normalizeToolCall({
    id: "ready",
    name: "sandbox_service_control",
    args: {
      action: "readiness",
      service: "api",
      command: "curl -f http://api:8080/health",
      intervalMs: 250,
    },
  }) as { name: string; args: Record<string, unknown> };

  assert.equal(normalized.name, "sandbox_service_control");
  assert.equal(normalized.args.action, "wait_ready");
  assert.equal(normalized.args.intervalMs, 250);
});

test("sandbox service recreate action normalizes for mount recovery", () => {
  const normalized = normalizeToolCall({
    id: "recreate",
    name: "sandbox_service_control",
    args: { action: "recreate", service: "api" },
  }) as { name: string; args: Record<string, unknown> };

  assert.equal(normalized.args.action, "recreate");
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

test("service mount repair is limited to one exact app bind target", () => {
  const mounts = [
    { Type: "bind", Source: "/tmp/source-file", Destination: "/app/server" },
    { Type: "volume", Source: "/var/lib/docker/volume", Destination: "/app/data" },
  ];
  assert.equal(selectExactBindMountFileRepairSource(mounts, "/app/server"), "/tmp/source-file");
  assert.equal(selectExactBindMountFileRepairSource(mounts, "/app/data"), undefined);
  assert.equal(selectExactBindMountFileRepairSource(mounts, "/etc/passwd"), undefined);
  assert.equal(isConclusiveServiceMountOrEntrypointFailure("python: can't open file '/app/server': Is a directory"), true);
});

test("container layer diagnosis detects a mounted directory shadowing an image file", () => {
  assert.deepEqual(
    detectServicePathTypeMismatches(
      { "decryptor_server.py": "directory", artifacts: "directory" },
      { "decryptor_server.py": "file", artifacts: "directory" },
    ),
    [
      {
        path: "/app/decryptor_server.py",
        mountedType: "directory",
        imageType: "file",
        diagnosis: "mount_shadow_or_damage",
      },
    ],
  );
});

test("sandbox service image inspection and restoration actions normalize", () => {
  const inspect = normalizeToolCall({
    id: "inspect-image",
    name: "sandbox_service_control",
    args: { action: "inspect_image", service: "api" },
  }) as { args: Record<string, unknown> };
  const restore = normalizeToolCall({
    id: "restore-image",
    name: "sandbox_service_control",
    args: { action: "restore_from_image", service: "api", targetPath: "/app/server.py" },
  }) as { args: Record<string, unknown> };

  assert.equal(inspect.args.action, "inspect_image");
  assert.equal(restore.args.action, "restore_from_image");
  assert.equal(restore.args.targetPath, "/app/server.py");
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

test("service resolver prefers a unique sibling service over a matching client name", () => {
  const services = [
    { name: "long-program-client", role: "client" as const },
    { name: "long-program-program-1", role: "service" as const },
  ];
  assert.equal(selectSandboxServiceName(services, "program"), "long-program-program-1");
  assert.equal(selectSandboxServiceName(services), "long-program-program-1");
});

test("runtime injects one generic service readiness recovery after a failed service probe", () => {
  const previous = process.env.REAPER_TBENCH_CONTAINER_NAME;
  process.env.REAPER_TBENCH_CONTAINER_NAME = "client";
  try {
    const call = buildAutomaticServiceRecoveryCall(
      [{ id: "next", name: "read_file", args: { path: "README.md" } }],
      [failedShell("probe", "curl -f http://api:8080/health", "curl: (6) Could not resolve host: api")],
      { enabled: true, readinessTimeoutMs: 30_000, autoRecover: true, maxAutoRecoveriesPerService: 1 },
    );
    assert.equal(call?.name, "sandbox_service_control");
    assert.deepEqual(call?.args, { action: "wait_ready", service: "api", timeoutMs: 30_000 });
  } finally {
    if (previous === undefined) delete process.env.REAPER_TBENCH_CONTAINER_NAME;
    else process.env.REAPER_TBENCH_CONTAINER_NAME = previous;
  }
});

test("runtime injects recovery after a sibling service is conclusively reported crashed", () => {
  const previous = process.env.REAPER_TBENCH_CONTAINER_NAME;
  process.env.REAPER_TBENCH_CONTAINER_NAME = "client";
  try {
    const call = buildAutomaticServiceRecoveryCall(
      [{ id: "inspect", name: "sandbox_service_control", args: { action: "logs", service: "api-1" } }],
      [
        {
          toolCallId: "list",
          name: "sandbox_service_control",
          ok: true,
          durationMs: 1,
          args: { action: "list" },
          output: {
            services: [
              { name: "client", role: "client", lifecycle: "starting" },
              { name: "api-1", role: "service", lifecycle: "crashed" },
            ],
          },
        },
      ],
      { enabled: true, readinessTimeoutMs: 30_000, autoRecover: true, maxAutoRecoveriesPerService: 1 },
    );
    assert.deepEqual(call?.args, { action: "wait_ready", service: "api-1", timeoutMs: 30_000 });
  } finally {
    if (previous === undefined) delete process.env.REAPER_TBENCH_CONTAINER_NAME;
    else process.env.REAPER_TBENCH_CONTAINER_NAME = previous;
  }
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
    name: "run_shell_command",
    ok: true,
    durationMs: 1,
    args: { cmd },
    output: { exitCode: 0, stdout, stderr: "" },
  };
}

function failedShell(id: string, cmd: string, message: string): ToolResult {
  return {
    toolCallId: id,
    name: "run_shell_command",
    ok: false,
    durationMs: 1,
    args: { cmd },
    error: { code: "command_failed", message },
  };
}
