/**
 * End-to-end sanity test for the progressive tool disclosure mechanism.
 *
 * Asserts:
 *   - `CORE_TOOL_NAMES` is non-empty and contains the always-present basics.
 *   - `ON_DEMAND_TOOL_NAMES` is the complement of `CORE_TOOL_NAMES` in
 *     the registry — no overlap, no gaps.
 *   - `search_tools` (executeSearchTools) returns matches for a query
 *     pointing at an on-demand tool and promotes it into the discovered
 *     set so the next turn renders full schemas.
 *   - The union of core + on-demand exactly equals the registry keys.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  toolRegistry,
  CORE_TOOL_NAMES,
  ON_DEMAND_TOOL_NAMES,
  type ToolName,
} from "../../../src/tools/registry.js";
import { executeSearchTools } from "../../../src/tools/write/search-tools.js";

test("CORE_TOOL_NAMES contains the expected always-present basics", () => {
  const expected: ToolName[] = [
    "read_file",
    "write_file",
    "edit_file",
    "replace_in_file",
    "run_shell_command",
    "list_directory",
    "grep_search",
    "search_tools",
  ];
  for (const name of expected) {
    assert.ok(CORE_TOOL_NAMES.has(name), `Expected '${name}' in CORE_TOOL_NAMES`);
  }
});

test("CORE_TOOL_NAMES and ON_DEMAND_TOOL_NAMES partition the registry", () => {
  const registryKeys = Object.keys(toolRegistry);
  const union = new Set([...CORE_TOOL_NAMES, ...ON_DEMAND_TOOL_NAMES]);
  assert.deepEqual(
    [...union].sort(),
    [...registryKeys].sort(),
    "CORE + ON_DEMAND must exactly equal the registry keys",
  );

  // No overlap.
  for (const name of CORE_TOOL_NAMES) {
    assert.ok(
      !ON_DEMAND_TOOL_NAMES.has(name),
      `'${name}' is in both CORE_TOOL_NAMES and ON_DEMAND_TOOL_NAMES`,
    );
  }
});

test("search_tools promotes an on-demand tool into full-schema rendering", () => {
  // 'web_search' is registered but should not be in core.
  assert.ok(
    !CORE_TOOL_NAMES.has("web_search"),
    "Test assumes web_search is on-demand; update test if CORE set changes",
  );

  const result = executeSearchTools("search the web for docs", "run-test-1");

  // Returns matches (top 6 by score).
  assert.ok(result.matches.length > 0, "Expected at least one match");
  assert.ok(result.matches.length <= 6, "Expected at most 6 matches");

  // web_search is one of the matches.
  const foundWebSearch = result.matches.some((m) => m.name === "web_search");
  assert.ok(foundWebSearch, "Expected web_search in the search results");

  // Discovered list contains it (so the next turn renders full schemas).
  assert.ok(
    result.discovered.includes("web_search"),
    "Expected web_search to be promoted to the discovered set",
  );
});

test("search_tools select:shortcut promotes specific tools without scoring", () => {
  const result = executeSearchTools("select:activate_skill", "run-test-2");
  assert.equal(result.discovered.length, 1);
  assert.equal(result.discovered[0], "activate_skill");
});
