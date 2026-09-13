/**
 * Wire-up test for which viewer names are core, which are deferred, and which
 * no longer exist as registry entries at all.
 *
 * The three sets are separate on purpose. A name in neither set and not in the
 * registry is retired: nothing renders its schema and nothing advertises it.
 * It is still *callable* through the alias map, which is the difference between
 * retiring a name and breaking a model that learned it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CORE_TOOL_NAMES,
  ON_DEMAND_TOOL_NAMES,
  toolRegistry,
} from "../../../src/tools/registry.js";

test("viewer tools that survived consolidation are in CORE_TOOL_NAMES", () => {
  assert.ok(CORE_TOOL_NAMES.has("file_view"));
  assert.ok(CORE_TOOL_NAMES.has("file_edit"));
  // `file_find` moved out of Core: a literal-substring search inside one file
  // is a specialization of reading it, not a thing the model needs every turn.
  assert.ok(!CORE_TOOL_NAMES.has("file_find"));
  assert.ok(ON_DEMAND_TOOL_NAMES.has("file_find"));
});

test("retired names are neither in the registry nor deferrable", () => {
  assert.ok(CORE_TOOL_NAMES.has("grep_search"));
  assert.ok(CORE_TOOL_NAMES.has("write_file"));
  assert.ok(CORE_TOOL_NAMES.has("bash"));
  for (const retired of ["view_file", "file_scroll"]) {
    // Absent from both sets, and absent from the registry — so the deferred
    // inventory never advertises a name that no longer resolves to a schema.
    // They still reach `file_view` through the alias map in `normalize.ts`,
    // which is what keeps a model that emits the old name working instead of
    // punished. (`edit_file` is not in this list: it is a registry tool of its
    // own — multi-block search and replace — not an alias of `file_edit`.)
    assert.ok(!CORE_TOOL_NAMES.has(retired), `${retired} should not be core`);
    assert.ok(!ON_DEMAND_TOOL_NAMES.has(retired), `${retired} should not be deferred`);
    assert.ok(!(retired in toolRegistry), `${retired} should not be registered`);
  }
});

test("Phase 5 removed read_file and replace_in_file entirely", () => {
  assert.ok(!CORE_TOOL_NAMES.has("read_file"));
  assert.ok(!CORE_TOOL_NAMES.has("replace_in_file"));
  assert.ok(!ON_DEMAND_TOOL_NAMES.has("read_file"));
  assert.ok(!ON_DEMAND_TOOL_NAMES.has("replace_in_file"));
  assert.ok(!("read_file" in toolRegistry));
  assert.ok(!("replace_in_file" in toolRegistry));
});
