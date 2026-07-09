/**
 * Build-like fresh repo tasks should keep a compact early tool surface before
 * the model has shipped artifacts, but the model-facing names must remain
 * canonical. Scratchpad is on-demand unless the user prompt mentions it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildGeneralAgentTools } from "../../../src/runtime/agent-tools.js";
import { selectGeneralAgentToolsForTurn } from "../../../src/runtime/engine.js";

const buildRequest = {
  payload: {
    prompt: "Build a production-style full-stack app with apps/api, apps/web, packages/shared, tests, and docs.",
  },
};

const buildWithScratchpadRequest = {
  payload: {
    prompt: "Build the app. Store the release token in scratchpad first, then write RESULT.json.",
  },
};

const nonBuildRequest = {
  payload: {
    prompt: "Fix the typo in README.md",
  },
};

test("build fast-start exposes canonical viewer/edit/write/bash/search surface before any writes", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(
    names.sort(),
    ["bash", "file_edit", "file_find", "file_scroll", "file_view", "grep_search", "list_directory", "search_tools", "write_file"].sort(),
  );
  assert.ok(!names.includes("scratchpad"));
});

test("build fast-start promotes scratchpad only when user prompt mentions it", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildWithScratchpadRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.ok(names.includes("scratchpad"));
  assert.ok(names.includes("search_tools"));
});

test("build fast-start keeps canonical viewer tools until enough artifacts exist", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: {
      toolResults: Array.from({ length: 5 }, (_, index) => ({ ok: true, name: "write_file", args: { path: `file-${index}.ts` } })),
    } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(
    names.sort(),
    ["bash", "file_edit", "file_find", "file_scroll", "file_view", "grep_search", "list_directory", "search_tools", "write_file"].sort(),
  );
});

test("non-build tasks keep the core tool surface without scratchpad by default", () => {
  const all = buildGeneralAgentTools().map((tool) => tool.name);
  const selected = selectGeneralAgentToolsForTurn({
    request: nonBuildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(selected, all);
  assert.ok(!selected.includes("scratchpad"));
});
