import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundaryPreflightStep,
  getBoundaryPreflightBlocker,
  guardBoundaryPreflightToolCalls,
  hasBoundaryPreflightEvidence,
  promptRequiresBoundaryPreflight,
  requiresBoundaryPreflightEvidence,
} from "../../src/runtime/boundary-preflight.js";
import type { ToolCall, ToolResult } from "../../src/tools/types.js";

const boundaryStep = {
  id: "inspect-layout",
  title: "Inspect serialized layout",
  type: "inspect",
  instructions: "Determine whether the legacy on-disk representation width and pointer layout match the current platform.",
  successCriteria: ["A justified width/layout compatibility decision is recorded."],
  advancementEvidence: ["Command-backed layout evidence and selected compatibility strategy."],
};

test("recognizes tasks and steps that require boundary preflight", () => {
  assert.equal(promptRequiresBoundaryPreflight("Modernize a legacy custom file format loader for the current platform."), true);
  assert.equal(promptRequiresBoundaryPreflight("Rename a button label."), false);
  assert.equal(requiresBoundaryPreflightEvidence(boundaryStep), true);
});

test("boundary inspect step cannot advance on ordinary reads alone", () => {
  const reads: ToolResult[] = [
    { toolCallId: "read", name: "read_file", ok: true, durationMs: 1, args: { path: "src/format.ts" }, output: { content: "schema" } },
  ];
  assert.match(getBoundaryPreflightBlocker(boundaryStep, reads) ?? "", /command-backed external-representation invariant/);
});

test("command-backed representation evidence clears the boundary blocker", () => {
  const evidence: ToolResult[] = [
    {
      toolCallId: "probe",
      name: "run_shell_command",
      ok: true,
      durationMs: 1,
      args: { cmd: "./layout_probe", summary: "compare on-disk layout width with runtime pointer width" },
      output: {
        stdout:
          "BOUNDARY_EVIDENCE=disk_offset_width=4 runtime_pointer_width=8\nBOUNDARY_COMPOSITE_CHECK=external_mesh_stride=36 runtime_mesh_stride=56\nBOUNDARY_DECISION=adapter-required\nBOUNDARY_STRATEGY=parse-fixed-width-offsets\n",
      },
    },
  ];
  assert.equal(hasBoundaryPreflightEvidence(evidence), true);
  assert.equal(getBoundaryPreflightBlocker(boundaryStep, evidence), undefined);
});

test("successful compile and primitive facts do not satisfy boundary preflight", () => {
  const superficialEvidence: ToolResult[] = [
    {
      toolCallId: "probe",
      name: "run_shell_command",
      ok: true,
      durationMs: 1,
      args: { cmd: "./layout_probe", summary: "check on-disk layout assumptions" },
      output: { stdout: "float=4 int=4 double=8\nendian=little compiled=yes\n" },
    },
  ];
  assert.equal(hasBoundaryPreflightEvidence(superficialEvidence), false);
  assert.match(getBoundaryPreflightBlocker(boundaryStep, superficialEvidence) ?? "", /BOUNDARY_EVIDENCE/);
});

test("boundary decision without an executable strategy does not unlock edits", () => {
  const incompleteEvidence: ToolResult[] = [
    {
      toolCallId: "probe",
      name: "run_shell_command",
      ok: true,
      durationMs: 1,
      args: { cmd: "./layout_probe", summary: "compare on-disk layout with runtime representation" },
      output: {
        stdout: "BOUNDARY_EVIDENCE=disk_offset_width=4 runtime_pointer_width=8\nBOUNDARY_DECISION=adapter-required\n",
      },
    },
  ];

  assert.equal(hasBoundaryPreflightEvidence(incompleteEvidence), false);
});

test("header and primitive compatibility without a composite check does not unlock edits", () => {
  const incompleteEvidence: ToolResult[] = [
    {
      toolCallId: "probe",
      name: "run_shell_command",
      ok: true,
      durationMs: 1,
      args: { cmd: "./layout_probe", summary: "compare on-disk layout with runtime representation" },
      output: {
        stdout:
          "BOUNDARY_EVIDENCE=header=32 int=4 float=4 pointer=8\nBOUNDARY_DECISION=compatible\nBOUNDARY_STRATEGY=use-native-layout\n",
      },
    },
  ];

  assert.equal(hasBoundaryPreflightEvidence(incompleteEvidence), false);
});

test("measured boundary evidence remains valid for later implementation steps", () => {
  const evidence: ToolResult[] = [
    {
      toolCallId: "probe",
      name: "run_shell_command",
      ok: true,
      durationMs: 1,
      args: { cmd: "./schema_probe", summary: "compare persisted schema with runtime representation" },
      output: {
        stdout:
          "BOUNDARY_EVIDENCE=persisted_version=1 runtime_version=2\nBOUNDARY_COMPOSITE_CHECK=external_schema_v1_fields=8 runtime_schema_v2_fields=10\nBOUNDARY_DECISION=adapter-required\nBOUNDARY_STRATEGY=translate-v1-to-v2\n",
      },
    },
  ];
  const laterStep = {
    ...boundaryStep,
    id: "implement-adapter",
    title: "Implement compatibility adapter",
  };

  assert.equal(getBoundaryPreflightBlocker(laterStep, evidence), undefined);
});

test("boundary preflight blocks source edits and broad read drift before evidence", () => {
  const calls: ToolCall[] = [
    { id: "edit", name: "write_file", args: { path: "src/loader.ts", content: "changed" } },
    { id: "tmp", name: "write_file", args: { path: ".reaper/tmp/probe.ts", content: "probe" } },
    { id: "read", name: "read_file", args: { path: "src/more.ts" } },
    { id: "check", name: "run_shell_command", args: { cmd: "npm test", summary: "verify the blocked edit" } },
  ];
  const guarded = guardBoundaryPreflightToolCalls(calls, boundaryStep, [], 2, 2);

  assert.deepEqual(guarded.allowed.map((call) => call.id), ["tmp"]);
  assert.deepEqual(guarded.blockedResults.map((result) => result.toolCallId), ["edit", "read", "check"]);
  assert.ok(guarded.blockedResults.every((result) => result.error?.code === "boundary_preflight_blocked"));
});

test("pre-plan synthetic boundary step blocks source edits", () => {
  const guarded = guardBoundaryPreflightToolCalls(
    [{ id: "edit", name: "write_file", args: { path: "src/loader.ts", content: "changed" } }],
    createBoundaryPreflightStep("pre-plan-boundary-invariant"),
    [],
    0,
    2,
  );

  assert.deepEqual(guarded.allowed, []);
  assert.equal(guarded.blockedResults[0]?.error?.code, "boundary_preflight_blocked");
});

test("boundary preflight blocks cross-context temporary helper dependencies", () => {
  const guarded = guardBoundaryPreflightToolCalls(
    [
      { id: "tmp", name: "write_file", args: { path: ".reaper/tmp/probe.cpp", content: "int main(){}" } },
      {
        id: "run",
        name: "run_shell_command",
        args: { cmd: "g++ .reaper/tmp/probe.cpp -o .reaper/tmp/probe && .reaper/tmp/probe", summary: "run layout probe" },
      },
    ],
    boundaryStep,
    [],
    0,
    2,
  );

  assert.deepEqual(guarded.allowed, []);
  assert.ok(guarded.blockedResults.every((result) => result.error?.message.includes("atomically inside one run_shell_command")));
});
