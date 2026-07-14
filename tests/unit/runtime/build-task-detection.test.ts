/** Build-task detection controls runtime tool and output budgeting. */
import test from "node:test";
import assert from "node:assert/strict";

import { detectBuildLikeTask } from "../../../src/runtime/task-contract.js";
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


test("bash tool description positions shell as execution, not file reading", () => {
  assert.match(toolRegistry.bash.description, /package installs, tests, builds, typechecks/);
  assert.match(toolRegistry.bash.description, /Do not use bash for file reads/i);
  assert.match(toolRegistry.bash.description, /inspect that path with file_view/i);
});
