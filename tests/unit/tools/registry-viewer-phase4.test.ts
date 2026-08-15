/**
 * Phase-4/5 wire-up test: viewer tools are promoted to CORE_TOOL_NAMES so
 * the model sees them every turn, while legacy `read_file` and
 * `replace_in_file` were removed entirely. `view_file` and `edit_file`
 * remain on-demand registry tools.
 *
 * Writes and grep_search stay always-on for full-file rewrites and
 * cross-file patterns respectively.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CORE_TOOL_NAMES,
  ON_DEMAND_TOOL_NAMES,
  toolRegistry,
} from "../../../src/tools/registry.js";

test("Phase 4 promoted viewer tools to CORE_TOOL_NAMES", () => {
  assert.ok(CORE_TOOL_NAMES.has("file_view"));
  assert.ok(CORE_TOOL_NAMES.has("file_scroll"));
  assert.ok(CORE_TOOL_NAMES.has("file_find"));
  assert.ok(CORE_TOOL_NAMES.has("file_edit"));
});

test("Phase 4 keeps grep_search, write_file, and bash always-on while legacy viewer aliases stay deferred", () => {
  assert.ok(CORE_TOOL_NAMES.has("grep_search"));
  assert.ok(CORE_TOOL_NAMES.has("write_file"));
  assert.ok(CORE_TOOL_NAMES.has("bash"));
  assert.ok(!CORE_TOOL_NAMES.has("view_file"));
  assert.ok(!CORE_TOOL_NAMES.has("edit_file"));
  assert.ok(ON_DEMAND_TOOL_NAMES.has("view_file"));
  assert.ok(ON_DEMAND_TOOL_NAMES.has("edit_file"));
});

test("Phase 5 removed read_file and replace_in_file entirely", () => {
  assert.ok(!CORE_TOOL_NAMES.has("read_file"));
  assert.ok(!CORE_TOOL_NAMES.has("replace_in_file"));
  assert.ok(!ON_DEMAND_TOOL_NAMES.has("read_file"));
  assert.ok(!ON_DEMAND_TOOL_NAMES.has("replace_in_file"));
  assert.ok(!("read_file" in toolRegistry));
  assert.ok(!("replace_in_file" in toolRegistry));
});
