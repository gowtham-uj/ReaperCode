/**
 * Build-like fresh repo tasks should not expose the full exploration/planning
 * surface before the model has shipped artifacts. This prevents the A/B failure
 * where Reaper spent early turns on read/list/env loops while the reference
 * agent immediately wrote many files.
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

test("build fast-start mirrors Pi's minimal read/bash/edit/write surface before any writes", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["bash", "edit", "grep", "ls", "read", "write"].sort());
});

test("build fast-start exposes read/ls/grep until enough artifacts exist", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: {
      toolResults: Array.from({ length: 5 }, (_, index) => ({ ok: true, name: "write_file", args: { path: `file-${index}.ts` } })),
    } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["bash", "edit", "grep", "ls", "read", "write"].sort());
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
