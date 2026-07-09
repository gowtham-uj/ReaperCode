/**
 * The main agent's default tool surface should prioritize executable
 * coding actions, not bookkeeping/control-plane tools. A live A/B showed the
 * model burned its first 9 requests on update_plan/update_todo before writing
 * any files. Those tools are still parseable internally for legacy/control
 * flows, but they must not be exposed in the default model-facing surface.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildGeneralAgentTools } from "../../../src/runtime/agent-tools.js";

test("default main-agent tools expose executable coding tools, not plan/todo bookkeeping", () => {
  const tools = buildGeneralAgentTools();
  const names = tools.map((tool) => tool.name);

  assert.ok(names.includes("write_file"));
  assert.ok(names.includes("file_view"));
  assert.ok(names.includes("file_scroll"));
  assert.ok(names.includes("file_find"));
  assert.ok(names.includes("file_edit"));
  assert.ok(!names.includes("read_file"));
  assert.ok(!names.includes("replace_in_file"));
  assert.ok(names.includes("bash"));
  assert.ok(!names.includes("update_plan"));
  assert.ok(!names.includes("update_todo"));
});

test("write_file description encourages file creation/overwrite for build tasks", () => {
  const write = buildGeneralAgentTools().find((tool) => tool.name === "write_file");
  assert.ok(write);
  assert.match(write.description, /Creates the file if it doesn't exist/);
  assert.match(write.description, /automatically creates parent directories/);
  assert.match(write.description, /many focused write_file calls/);
});
