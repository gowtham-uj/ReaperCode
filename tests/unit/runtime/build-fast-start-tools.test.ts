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

/**
 * The named core surface, in one place. Build narrowing exists to keep the wire
 * small, not to hide a capability: every core tool has to survive it, because
 * `renderAvailableTools` omits core names from the deferred list on the
 * assumption that they are already attached. A core tool dropped here would be
 * invisible in both directions.
 *
 * Written out rather than derived from `CORE_TOOL_NAMES`, deliberately: a list
 * derived from the registry would agree with the registry by construction and
 * would stop being able to tell anyone that a tool had been removed from the
 * first turn. `eval` is on it for the reason `search_tools` is — both are
 * routing tools, and a routing tool that is not on the wire on the first turn
 * cannot be chosen for the task that needed it. A build task is exactly the task
 * where a model should be able to decide "this is forty reads, write a loop"
 * before it has written anything.
 */
const CORE_SURFACE = [
  "bash",
  "eval",
  "file_edit",
  "file_view",
  "git_diff",
  "git_status",
  "glob",
  "grep_search",
  "list_directory",
  "search_tools",
  "write_file",
].sort();

test("build fast-start exposes the full core surface before any writes", () => {
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(),
  }).map((tool) => tool.name);
  assert.deepEqual(names.sort(), CORE_SURFACE);
  assert.ok(!names.includes("scratchpad"));
  // Nothing was promoted, so `file_find` is not on the wire — the model reaches
  // it through search_tools like any other optional tool. When it *is*
  // promoted, the next test says it must survive.
  assert.ok(!names.includes("file_find"));
});

test("build narrowing keeps every deferred tool the model already promoted", () => {
  // Deferred tools the model unlocked are part of the turn's tool set, and
  // narrowing must not revoke a schema the model just asked for — it has no way
  // to tell "narrowed" from "gone".
  //
  // This assertion used to read the opposite way, and that encoded the bug it
  // should have caught. The old implementation rebuilt the wire from a fixed
  // name list, so *no* promotion survived while a build task was under twenty
  // writes. A live run showed the cost: the model called `search_tools`, was
  // told `create_checkpoint` was unlocked, saw it listed as available, never
  // received its schema, re-searched four times, tried calling it blind, and
  // gave up. The test asserted the outcome rather than the intent.
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(["file_find", "skim_file"]),
  }).map((tool) => tool.name);
  assert.ok(names.includes("file_find"), "a promoted file_find should survive narrowing");
  assert.ok(names.includes("skim_file"), "a promoted deferred tool must keep its schema");
  assert.deepEqual(names.sort(), [...CORE_SURFACE, "file_find", "skim_file"].sort());
});

test("build narrowing keeps promoted tools on the wire for as long as it applies", () => {
  // The narrowing runs on *every* turn until the write threshold, so a dropped
  // promotion is not a one-turn delay — it is revoked for the whole early
  // phase, which for a build task is most of the run.
  for (const writes of [0, 5, 19]) {
    const names = selectGeneralAgentToolsForTurn({
      request: buildRequest as never,
      state: {
        toolResults: Array.from({ length: writes }, (_, index) => ({
          ok: true,
          name: "write_file",
          args: { path: `file-${index}.ts` },
        })),
      } as never,
      tools: buildGeneralAgentTools(["create_checkpoint"]),
    }).map((tool) => tool.name);
    assert.ok(
      names.includes("create_checkpoint"),
      `promotion must survive narrowing after ${writes} writes`,
    );
  }
});

test("build narrowing does not reorder into duplicates", () => {
  // The core names lead the list and the rest follow, so a core tool that was
  // also passed in as a promotion must appear exactly once.
  const names = selectGeneralAgentToolsForTurn({
    request: buildRequest as never,
    state: { toolResults: [] } as never,
    tools: buildGeneralAgentTools(["glob", "skim_file"]),
  }).map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `duplicates in ${names.join(", ")}`);
  assert.deepEqual(names.sort(), [...CORE_SURFACE, "skim_file"].sort());
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
  assert.deepEqual(names.sort(), CORE_SURFACE);
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
