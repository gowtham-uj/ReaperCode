import assert from "node:assert/strict";
import test from "node:test";

import { buildGeneralAgentTools } from "../../../src/runtime/agent-tools.js";
import { CORE_TOOL_NAMES, toolRegistry, type ToolName } from "../../../src/tools/registry.js";

test("main-agent tool descriptors are derived from the registry core list", () => {
  const descriptors = buildGeneralAgentTools();
  const descriptorNames = descriptors.map((tool) => tool.name);

  assert.deepEqual(
    descriptorNames,
    [...CORE_TOOL_NAMES],
    "model-facing tool order/list must come from CORE_TOOL_NAMES, not a duplicate static table",
  );

  for (const descriptor of descriptors) {
    const registryEntry = toolRegistry[descriptor.name as ToolName];
    assert.ok(registryEntry, `missing registry entry for ${descriptor.name}`);
    assert.equal(
      descriptor.description,
      registryEntry.description,
      `${descriptor.name} description must be registry-derived`,
    );
  }
});

test("model-facing core surface does not expose complete_task", () => {
  const descriptors = buildGeneralAgentTools();
  assert.ok(!descriptors.some((tool) => tool.name === "complete_task"));
  assert.ok(!CORE_TOOL_NAMES.has("complete_task"));
  // Back-compat execution can keep the registry entry, but the model-facing
  // core surface must derive from CORE_TOOL_NAMES and exclude it.
  assert.ok("complete_task" in toolRegistry);
});

test("bash model-facing schema requires timeout in seconds from registry schema", () => {
  const bash = buildGeneralAgentTools().find((tool) => tool.name === "bash");
  assert.ok(bash, "bash tool must be in core tool surface");
  assert.equal(bash.description, toolRegistry.bash.description);

  const schema = bash.inputSchema as {
    required?: string[];
    properties?: Record<string, { description?: string; minimum?: number; maximum?: number }>;
  };

  assert.ok(schema.required?.includes("timeout"), "bash timeout must be required in model-facing schema");
  assert.equal(schema.properties?.timeout?.minimum, 1);
  assert.equal(schema.properties?.timeout?.maximum, 3600);
  assert.match(schema.properties?.timeout?.description ?? "", /SECONDS/);
  assert.match(bash.description, /NO DEFAULT TIMEOUT/);
});
