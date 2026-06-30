/**
 * Build-like fresh repo tasks should keep a compact early tool surface before
 * the model has shipped artifacts, but the model-facing names must remain
 * canonical. In particular, viewer tools are exposed directly as file_view /
 * file_scroll / file_find / file_edit — no short-name aliases.
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
  assert.deepEqual(names.sort(), ["bash", "file_edit", "file_find", "file_scroll", "file_view", "grep_search", "list_directory", "write_file"].sort());
});

test("build fast-start keeps canonical viewer tools until enough artifacts exist", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: {
      toolResults: Array.from({ length: 5 }, (_, index) => ({ ok: true, name: "write_file", args: { path: `file-${index}.ts` } })),
    } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["bash", "file_edit", "file_find", "file_scroll", "file_view", "grep_search", "list_directory", "write_file"].sort());
});

test("non-build tasks keep the full tool surface", () => {
  const all = buildGeneralAgentTools().map((tool) => tool.name);
  const selected = selectGeneralAgentToolsForTurn({
    request: nonBuildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(selected, all);
});
