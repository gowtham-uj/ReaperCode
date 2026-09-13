import test from "node:test";
import assert from "node:assert/strict";

import { executeSearchTools } from "../../src/tools/write/search-tools.js";
import { clearDiscoveredTools, getDiscoveredTools } from "../../src/tools/discovery.js";

test("search_tools supports direct select syntax and discovers exact tools", () => {
  const runId = "tool-search-select-test";
  clearDiscoveredTools(runId);

  const result = executeSearchTools("select:job,skim_file", runId);

  assert.deepEqual(result.discovered, ["job", "skim_file"]);
  assert.equal(result.matches[0]?.name, "job");
  assert.equal(result.matches[1]?.name, "skim_file");
  assert.equal(getDiscoveredTools(runId).has("job"), true);
  assert.equal(getDiscoveredTools(runId).has("skim_file"), true);
});

test("search_tools supports required +terms for capability discovery", () => {
  const runId = "tool-search-required-test";
  clearDiscoveredTools(runId);

  const result = executeSearchTools("+background process", runId);

  assert.ok(result.matches.some((item) => item.name === "job" || item.name === "bash"));
});
