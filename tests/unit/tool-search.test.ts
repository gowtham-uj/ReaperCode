import test from "node:test";
import assert from "node:assert/strict";

import { executeSearchTools } from "../../src/tools/write/search-tools.js";
import { clearDiscoveredTools, getDiscoveredTools } from "../../src/tools/discovery.js";

test("search_tools supports direct select syntax and discovers exact tools", () => {
  const runId = "tool-search-select-test";
  clearDiscoveredTools(runId);

  const result = executeSearchTools("select:read_background_output,signal_process", runId);

  assert.deepEqual(result.discovered, ["read_background_output", "signal_process"]);
  assert.equal(result.matches[0]?.name, "read_background_output");
  assert.equal(result.matches[1]?.name, "signal_process");
  assert.equal(getDiscoveredTools(runId).has("read_background_output"), true);
  assert.equal(getDiscoveredTools(runId).has("signal_process"), true);
});

test("search_tools supports required +terms for capability discovery", () => {
  const runId = "tool-search-required-test";
  clearDiscoveredTools(runId);

  const result = executeSearchTools("+background process", runId);

  assert.ok(result.matches.some((item) => item.name === "read_background_output" || item.name === "run_shell_command"));
});
