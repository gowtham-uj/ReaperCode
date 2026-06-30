import assert from "node:assert/strict";
import test from "node:test";
import {
  getBoundaryPreflightBlocker,
  hasBoundaryPreflightEvidence,
  promptRequiresBoundaryPreflight,
  requiresBoundaryPreflightEvidence,
} from "../../src/runtime/boundary-preflight.js";
import type { ToolResult } from "../../src/tools/types.js";

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
      name: "bash",
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
      name: "bash",
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
      name: "bash",
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
      name: "bash",
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
      name: "bash",
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
