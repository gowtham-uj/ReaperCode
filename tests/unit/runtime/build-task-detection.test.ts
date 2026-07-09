/**
 * Tests for the build-task detection that drives the cockpit
 * "Build Task Guidance" advisory section.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildMainAgentCockpit, detectBuildLikeTask } from "../../../src/runtime/main-agent-prompt.js";
import { toolRegistry } from "../../../src/tools/registry.js";

function request(prompt: string) {
  return { payload: { prompt } };
}

test("detectBuildLikeTask: numbered feature list is detected", () => {
  assert.equal(
    detectBuildLikeTask(request("## Feature 1: Create Run\n## Feature 2: Status API")),
    true,
  );
});

test("detectBuildLikeTask: 'Build RepoPilot' is detected", () => {
  assert.equal(
    detectBuildLikeTask(request("Build a production-style full-stack app called RepoPilot")),
    true,
  );
});

test("detectBuildLikeTask: 'Implement add(a,b)' is detected", () => {
  assert.equal(
    detectBuildLikeTask(request("Implement a tiny math module that exports add(a,b), multiply(a,b)")),
    true,
  );
});

test("detectBuildLikeTask: 'scaffold monorepo' is detected", () => {
  assert.equal(
    detectBuildLikeTask(request("Scaffold a TypeScript monorepo with pnpm workspaces")),
    true,
  );
});

test("detectBuildLikeTask: prose question is NOT a build task", () => {
  assert.equal(
    detectBuildLikeTask(request("Why does TypeScript complain about my import path?")),
    false,
  );
});

test("detectBuildLikeTask: small edit request is NOT a build task", () => {
  assert.equal(
    detectBuildLikeTask(request("Fix the typo on line 42 of README.md")),
    false,
  );
});

test("detectBuildLikeTask: empty prompt is NOT a build task", () => {
  assert.equal(detectBuildLikeTask(request("")), false);
});

test("detectBuildLikeTask: missing prompt is NOT a build task", () => {
  assert.equal(detectBuildLikeTask({ payload: {} }), false);
  assert.equal(detectBuildLikeTask({}), false);
});

test("detectBuildLikeTask: handles top-level prompt field", () => {
  // Some callers pass the prompt at the request root, not nested under
  // payload. The detector should still recognize it.
  assert.equal(
    detectBuildLikeTask({ prompt: "Build a tiny todo app in TypeScript" }),
    true,
  );
});

test("cockpit renders a 'Shipped so far' block from tool results", () => {
  const toolResults = [
    {
      toolCallId: "1",
      name: "write_file",
      ok: true,
      durationMs: 5,
      args: { path: "package.json" },
      output: { bytes: 412 },
    },
    {
      toolCallId: "2",
      name: "write_file",
      ok: true,
      durationMs: 8,
      args: { path: "src/index.ts" },
      output: { bytes: 1024 },
    },
    {
      toolCallId: "3",
      name: "bash",
      ok: true,
      durationMs: 200,
      args: { cmd: "ls -la" },
      output: { stdout: "total 0\n" },
    },
    {
      toolCallId: "4",
      name: "write_file",
      ok: false,
      durationMs: 3,
      args: { path: "src/broken.ts" },
      output: { error: { message: "boom" } },
    },
  ];
  const cockpit = buildMainAgentCockpit(
    { toolResults, sessionSummary: null, contentPrep: null },
    { payload: { prompt: "Build a tiny app" } },
    null, null, null, null,
  );
  assert.match(cockpit, /Shipped so far \(3 files\):/);
  assert.match(cockpit, /write_file\s+package\.json\s+\(412B\)/);
  assert.match(cockpit, /write_file\s+src\/index\.ts\s+\(1024B\)/);
  assert.match(cockpit, /FAILED\s+write_file\s+src\/broken\.ts/);
});

test("build-task guidance is lean and does not mention Docker", () => {
  const cockpit = buildMainAgentCockpit(
    { toolResults: [], sessionSummary: null, contentPrep: null },
    { payload: { prompt: "Build a production TypeScript monorepo" } },
    null, null, null, null,
  );

  assert.match(cockpit, /BUILD task: ship artifacts/i);
  assert.match(cockpit, /Prefer write_file \/ file_edit/i);
  assert.doesNotMatch(cockpit, /docker compose up/i);
});

test("cockpit renders build progress with missing artifact areas", () => {
  const toolResults = [
    {
      toolCallId: "1",
      name: "write_file",
      ok: true,
      durationMs: 5,
      args: { path: "/tmp/work/package.json" },
      output: { bytesStaged: 500 },
    },
    {
      toolCallId: "2",
      name: "write_file",
      ok: true,
      durationMs: 5,
      args: { path: "/tmp/work/pnpm-workspace.yaml" },
      output: { bytesStaged: 40 },
    },
    {
      toolCallId: "3",
      name: "write_file",
      ok: true,
      durationMs: 5,
      args: { path: "/tmp/work/packages/shared/src/index.ts" },
      output: { bytesStaged: 1000 },
    },
  ];
  const cockpit = buildMainAgentCockpit(
    { toolResults, sessionSummary: null, contentPrep: null },
    { payload: { prompt: "Build RepoPilot" } },
    null, null, null, null,
    { workspaceRoot: "/tmp/work" },
  );

  // Pi has no "Build Progress" ranking; the cockpit still surfaces changed
  // files (so the model doesn't re-read what it just wrote) but not the
  // task-specific area ordering.
  assert.match(cockpit, /## Changed Files/);
  assert.match(cockpit, /packages\/shared/);
  assert.doesNotMatch(cockpit, /Build Progress/);
  assert.doesNotMatch(cockpit, /Recommended next write target/);
});

test("bash tool description positions shell as execution, not file reading", () => {
  assert.match(toolRegistry.bash.description, /package installs, tests, builds, typechecks/);
  assert.match(toolRegistry.bash.description, /Do not use bash as a file reader/i);
  assert.match(toolRegistry.bash.description, /Prefer `read_file` for targeted file inspection/i);
});
