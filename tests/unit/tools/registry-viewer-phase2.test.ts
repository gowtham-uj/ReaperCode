/**
 * Phase-2 wire-up test — schema-registration contract (still true in Phase 4).
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { toolRegistry } from "../../../src/tools/registry.js";

test("file_view is registered in toolRegistry", () => {
  assert.ok("file_view" in toolRegistry);
});

test("file_scroll is registered in toolRegistry", () => {
  assert.ok("file_scroll" in toolRegistry);
});

test("file_find is registered in toolRegistry", () => {
  assert.ok("file_find" in toolRegistry);
});

test("file_edit is registered in toolRegistry", () => {
  assert.ok("file_edit" in toolRegistry);
});
