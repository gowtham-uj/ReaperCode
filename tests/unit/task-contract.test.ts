import test from "node:test";
import assert from "node:assert/strict";

import { extractTaskContract, renderTaskContractForCockpit } from "../../src/runtime/task-contract.js";
import type { RepoInspection } from "../../src/runtime/repo-inspection.js";

const repoInspection: RepoInspection = {
  packageManagers: ["npm"],
  languages: ["TypeScript"],
  frameworks: ["Vitest"],
  testCommands: ["npm test"],
  buildCommands: ["npm run build", "npm run typecheck"],
  lintCommands: ["npm run lint"],
  entrypoints: ["src/index.ts"],
  configFiles: ["package.json", "tsconfig.json"],
  importantDirectories: ["src", "tests"],
  gitStatus: "clean",
  risks: [],
};

test("extractTaskContract summarizes a full-stack build request", () => {
  const contract = extractTaskContract("Implement a full-stack build pipeline for the dashboard with tests.", repoInspection);

  assert.equal(contract.userGoal, "Implement a full-stack build pipeline for the dashboard with tests.");
  assert.deepEqual(contract.deliverables, ["Implement full-stack build pipeline for the dashboard"]);
  assert.ok(contract.constraints.includes("Preserve existing behavior unless the request explicitly asks for a behavior change."));
  assert.ok(contract.forbiddenActions.includes("Do not remove unrelated behavior."));
  assert.ok(contract.acceptanceCriteria.includes("The requested build-related workflow is implemented or updated."));
  assert.deepEqual(contract.likelyValidation, ["npm test", "npm run build", "npm run typecheck"]);
});

test("extractTaskContract captures bugfix intent and likely tests", () => {
  const contract = extractTaskContract("Fix login session timeout when users refresh the page.", repoInspection);

  assert.deepEqual(contract.deliverables, ["Fix login session timeout when users refresh the page"]);
  assert.ok(contract.acceptanceCriteria.includes("The reported bug is fixed or the behavioral cause is clearly identified."));
  assert.ok(contract.acceptanceCriteria.includes("A regression test or targeted validation covers the bug when feasible."));
  assert.deepEqual(contract.likelyValidation, ["npm test"]);
});

test("extractTaskContract captures refactor intent without changing behavior", () => {
  const contract = extractTaskContract("Refactor the repo intelligence helpers without changing behavior.", repoInspection);

  assert.deepEqual(contract.deliverables, ["Refactor repo intelligence helpers"]);
  assert.ok(contract.constraints.includes("Respect any requested 'without' constraints."));
  assert.ok(contract.acceptanceCriteria.includes("Behavior remains unchanged except where the request explicitly asks otherwise."));
  assert.deepEqual(contract.likelyValidation, ["npm test", "npm run build", "npm run typecheck", "npm run lint"]);
});

test("extractTaskContract does not force tests for docs-only requests", () => {
  const contract = extractTaskContract("Update the README documentation for local setup.", repoInspection);

  assert.deepEqual(contract.deliverables, ["Update README documentation for local setup"]);
  assert.ok(contract.acceptanceCriteria.includes("Documentation changes are accurate and scoped to the request."));
  assert.deepEqual(contract.likelyValidation, ["Review documentation changes for accuracy."]);
});

test("extractTaskContract treats read-only requests as non-mutating", () => {
  const contract = extractTaskContract("Read-only review of the runtime architecture; do not modify files.", repoInspection);

  assert.deepEqual(contract.deliverables, ["Provide the requested analysis without modifying files."]);
  assert.ok(contract.constraints.includes("Do not modify files for read-only work."));
  assert.ok(contract.forbiddenActions.includes("Do not modify files."));
  assert.deepEqual(contract.likelyValidation, []);
});

test("extractTaskContract suggests repoInspection validation commands by task relevance", () => {
  const contract = extractTaskContract("Clean up and refactor command parsing style.", repoInspection);

  assert.deepEqual(contract.likelyValidation, ["npm test", "npm run build", "npm run typecheck", "npm run lint"]);
});

test("renderTaskContractForCockpit renders all contract fields", () => {
  const rendered = renderTaskContractForCockpit(
    extractTaskContract("Fix the flaky provider retry test; never skip verification.", repoInspection),
  );

  assert.match(rendered, /# Task Contract/);
  assert.match(rendered, /User goal: Fix the flaky provider retry test; never skip verification\./);
  assert.match(rendered, /Deliverables: Fix flaky provider retry test/);
  assert.match(rendered, /Forbidden actions: .*Never skip verification\./);
  assert.match(rendered, /Likely validation: npm test/);
});
