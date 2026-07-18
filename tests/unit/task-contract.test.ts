import test from "node:test";
import assert from "node:assert/strict";

import { extractTaskContract, renderTaskContractForCockpit } from "../../src/runtime/task-contract.js";

test("extractTaskContract summarizes a full-stack build request", () => {
  const contract = extractTaskContract("Implement a full-stack build pipeline for the dashboard with tests.");

  assert.equal(contract.userGoal, "Implement a full-stack build pipeline for the dashboard with tests.");
  assert.deepEqual(contract.deliverables, ["Implement full-stack build pipeline for the dashboard"]);
  assert.ok(contract.constraints.includes("Preserve existing behavior unless the request explicitly asks for a behavior change."));
  assert.ok(contract.forbiddenActions.includes("Do not remove unrelated behavior."));
  assert.ok(contract.acceptanceCriteria.includes("The requested build-related workflow is implemented or updated."));
  assert.ok(contract.likelyValidation.some((cmd) => /test/i.test(cmd)));
  assert.ok(contract.likelyValidation.some((cmd) => /build|typecheck/i.test(cmd)));
});

test("extractTaskContract captures bugfix intent and likely tests", () => {
  const contract = extractTaskContract("Fix login session timeout when users refresh the page.");

  assert.deepEqual(contract.deliverables, ["Fix login session timeout when users refresh the page"]);
  assert.ok(contract.acceptanceCriteria.includes("The reported bug is fixed or the behavioral cause is clearly identified."));
  assert.ok(contract.acceptanceCriteria.includes("A regression test or targeted validation covers the bug when feasible."));
  assert.ok(contract.likelyValidation.some((cmd) => /test/i.test(cmd)));
});

test("extractTaskContract captures refactor intent without changing behavior", () => {
  const contract = extractTaskContract("Refactor the repo intelligence helpers without changing behavior.");

  assert.deepEqual(contract.deliverables, ["Refactor repo intelligence helpers"]);
  assert.ok(contract.constraints.includes("Respect any requested 'without' constraints."));
  assert.ok(contract.acceptanceCriteria.includes("Behavior remains unchanged except where the request explicitly asks otherwise."));
  assert.ok(contract.likelyValidation.length >= 2);
});

test("extractTaskContract does not force tests for docs-only requests", () => {
  const contract = extractTaskContract("Update the README documentation for local setup.");

  assert.deepEqual(contract.deliverables, ["Update README documentation for local setup"]);
  assert.ok(contract.acceptanceCriteria.includes("Documentation changes are accurate and scoped to the request."));
  assert.deepEqual(contract.likelyValidation, ["Review documentation changes for accuracy."]);
});

test("extractTaskContract treats read-only requests as non-mutating", () => {
  const contract = extractTaskContract("Read-only review of the runtime architecture; do not modify files.");

  assert.deepEqual(contract.deliverables, ["Provide the requested analysis without modifying files."]);
  assert.ok(contract.constraints.includes("Do not modify files for read-only work."));
  assert.ok(contract.forbiddenActions.includes("Do not modify files."));
  assert.deepEqual(contract.likelyValidation, []);
});

test("extractTaskContract suggests validation commands by task relevance", () => {
  const contract = extractTaskContract("Clean up and refactor command parsing style.");

  assert.ok(contract.likelyValidation.length >= 2);
});

test("extractTaskContract ignores harness exec-environment boilerplate", () => {
  const wrapped = [
    "[exec environment — single-prompt run, no approval gate]",
    "Workspace root: workspace/scratch",
    "Tool rules:",
    "  1. Stay inside the workspace.",
    "  2. Do not create source files through shell heredocs or redirection.",
    "[end exec environment]",
    "",
    "User prompt:",
    "Create marker.txt containing OK and verify it with a bash command.",
  ].join("\n");
  const contract = extractTaskContract(wrapped);

  assert.equal(contract.userGoal, "Create marker.txt containing OK and verify it with a bash command.");
  assert.ok(
    contract.deliverables.every((item) => !/heredocs|redirection|Stay inside/i.test(item)),
    `boilerplate leaked into deliverables: ${contract.deliverables.join(" | ")}`,
  );
  assert.ok(contract.deliverables.some((item) => /marker\.txt/.test(item)));
});

test("renderTaskContractForCockpit renders all contract fields", () => {
  const rendered = renderTaskContractForCockpit(
    extractTaskContract("Fix the flaky provider retry test; never skip verification."),
  );

  assert.match(rendered, /# Task Contract/);
  assert.match(rendered, /User goal: Fix the flaky provider retry test; never skip verification\./);
  assert.match(rendered, /Deliverables: Fix flaky provider retry test/);
  assert.match(rendered, /Forbidden actions: .*Never skip verification\./);
  assert.match(rendered, /Likely validation:/);
});
