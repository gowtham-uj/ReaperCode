import test from "node:test";
import assert from "node:assert/strict";

import { normalizePlannerStepTypeLabel } from "../../src/runtime/engine.js";

test("planner keeps read-only inspection steps as inspect even when they mention future conversion", () => {
  const text = `inspect-codebase
Inspect MdfLib source files and JSON format spec
Read all source files and list the test_models directory to know which files need converting.
Read all header files and identify any existing build scripts.`;

  assert.equal(normalizePlannerStepTypeLabel("command", text), "inspect");
});

test("planner keeps source reading as inspect when build is only a noun phrase", () => {
  const text = `read-library-source
Read library source code and understand API
Read the main library header and source files to understand the API.
Check for any existing CMakeLists.txt or build scripts.`;

  assert.equal(normalizePlannerStepTypeLabel("command", text), "inspect");
});

test("planner labels implementation and porting work as command", () => {
  const text = `fix-source-compatibility
Port source code for Linux compatibility
Replace platform-specific types, includes, and APIs with portable equivalents.`;

  assert.equal(normalizePlannerStepTypeLabel("command", text), "command");
});

test("planner labels automated test execution as test", () => {
  const text = `run-unit-tests
Run pytest for the changed area
Execute pytest tests/test_converter.py and capture the result.`;

  assert.equal(normalizePlannerStepTypeLabel("command", text), "test");
});

test("planner labels acceptance validation as verify", () => {
  const text = `verify-output
Verify generated output compliance
Validate all generated JSON files against the required schema and acceptance conditions.`;

  assert.equal(normalizePlannerStepTypeLabel("command", text), "verify");
});
